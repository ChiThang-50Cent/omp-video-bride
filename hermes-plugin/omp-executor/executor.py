"""Direct authenticated OMP RPC executor plugin backend for Hermes.

Provides full native control over isolated OMP RPC client sessions via
authenticated internal TCP tunnels. Exposes session catalog discovery, explicit
new/resume lifecycle, asynchronous dispatch of all native RpcCommand types,
sequenced bounded event replay, interactive UI responses, and host tool/URI handling.
"""

from __future__ import annotations

import atexit
from collections import deque
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from typing import Any, Callable, Deque, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("hermes.plugin.omp_executor")

try:
    from omp_rpc import RpcClient
except ImportError:
    RpcClient = None  # type: ignore[assignment, misc]

_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-\.]{1,64}$")

# Exact set of 48 native RpcCommand types derived from pinned RpcCommand TypeScript union source:
# packages/coding-agent/src/modes/rpc/rpc-types.ts @ commit 8ac1309bd8adaddc891eeb389c545345073875be
SUPPORTED_COMMANDS: frozenset[str] = frozenset({
    # Protocol
    "negotiate_protocol",
    # Prompting & turn lifecycle
    "prompt",
    "steer",
    "follow_up",
    "remove_queued_message",
    "abort",
    "abort_and_prompt",
    "new_session",
    "open_session",
    # State & extension setup
    "get_state",
    "set_fast_mode",
    "get_available_commands",
    "get_entries",
    "get_tree",
    "set_todos",
    "set_host_tools",
    "set_host_uri_schemes",
    "set_subagent_subscription",
    "set_event_filter",
    "get_subagents",
    "get_subagent_messages",
    # Model
    "set_model",
    "cycle_model",
    "get_available_models",
    # Thinking
    "set_thinking_level",
    "cycle_thinking_level",
    "get_available_thinking_levels",
    # Queue modes
    "set_steering_mode",
    "set_follow_up_mode",
    "set_interrupt_mode",
    # Compaction
    "compact",
    "set_auto_compaction",
    # Retry
    "set_auto_retry",
    "abort_retry",
    # Bash execution
    "bash",
    "abort_bash",
    # Session & history
    "get_session_stats",
    "export_html",
    "switch_session",
    "branch",
    "get_branch_messages",
    "get_last_assistant_text",
    "set_session_name",
    "handoff",
    # Messages
    "get_messages",
    "get_messages_page",
    # Login
    "get_login_providers",
    "login",
})


def validate_executor_name(name: str) -> Tuple[bool, str]:
    if not name or not isinstance(name, str):
        return False, "Executor name must be a non-empty string"
    if not _NAME_RE.fullmatch(name):
        return False, (
            f"Invalid executor name '{name}': must be 1-64 alphanumeric, dash, dot, or underscore chars"
        )
    return True, ""


def derive_executor_id(session_id: str, logical_name: str) -> str:
    """Derive deterministic 64-char lowercase hex digest scoped to Hermes session_id."""
    return hashlib.sha256(f"{session_id}:{logical_name}".encode("utf-8")).hexdigest()


def get_tunnel_path() -> str:
    env_path = os.environ.get("OMP_EXECUTOR_TUNNEL")
    if env_path and os.path.isfile(env_path):
        return env_path
    plugin_sibling = Path(__file__).resolve().parent / "tcp_stdio.py"
    if plugin_sibling.is_file():
        return str(plugin_sibling)
    deploy_sibling = (
        Path(__file__).resolve().parents[2] / "deploy" / "direct-executor" / "tcp_stdio.py"
    )
    if deploy_sibling.is_file():
        return str(deploy_sibling)
    return env_path or "/opt/direct-executor/tcp_stdio.py"


# ---------------------------------------------------------------------------
# Pinned Native Client Adapter
# ---------------------------------------------------------------------------

class FrameWatcher:
    """Intercepts decoded raw JSON stdout frames before client dispatch."""

    def __init__(self, inner: Any, on_frame: Callable[[Dict[str, Any]], None]) -> None:
        self.inner = inner
        self.on_frame = on_frame

    def push(self, value: object) -> Optional[Dict[str, Any]]:
        frame = self.inner.push(value)
        if frame is not None and isinstance(frame, dict):
            try:
                self.on_frame(dict(frame))
            except Exception as exc:
                logger.error("Error in frame watcher: %s", exc)
        return frame


if RpcClient is not None:
    class PinnedRpcClient(RpcClient):  # type: ignore[misc]
        """Subclass of official RpcClient preventing default auto-rejection.

        Overrides host tool and host URI handlers so missing custom tool or URI
        registrations do not immediately emit automatic rejection error frames.
        Installs the raw frame watcher in _read_stdout_loop after start() has reset
        _frame_decoder, guaranteeing zero lost frames.
        """

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._raw_frame_cb: Optional[Callable[[Dict[str, Any]], None]] = None

        def set_raw_frame_callback(self, cb: Callable[[Dict[str, Any]], None]) -> None:
            self._raw_frame_cb = cb

        def _read_stdout_loop(self) -> None:
            # Official RpcClient.start() unconditionally resets _frame_decoder = _RpcFrameDecoder()
            # right before spawning stdout thread. Installing the watcher here ensures it wraps
            # the live decoder instance on the reader thread.
            if self._raw_frame_cb is not None:
                self._frame_decoder = FrameWatcher(self._frame_decoder, self._raw_frame_cb)
            super()._read_stdout_loop()

        def _handle_host_tool_call(self, payload: Dict[str, Any]) -> None:
            # Overridden: do not auto-reject when tool not in _custom_tools.
            pass

        def _handle_host_tool_cancel(self, payload: Dict[str, Any]) -> None:
            # Overridden: cancellation tracked in ExecutorSession.
            pass

        def _handle_host_uri_request(self, payload: Dict[str, Any]) -> None:
            # Overridden: do not auto-reject when scheme not in _host_uris.
            pass

        def _handle_host_uri_cancel(self, payload: Dict[str, Any]) -> None:
            # Overridden: cancellation tracked in ExecutorSession.
            pass
else:
    PinnedRpcClient = None  # type: ignore[assignment, misc]


# ---------------------------------------------------------------------------
# Executor Session
# ---------------------------------------------------------------------------

class ExecutorSession:
    """Manages an active OMP RpcClient instance, pending requests, and sequenced events."""

    def __init__(
        self,
        session_id: str,
        logical_name: str,
        digest: str,
        client_factory: Optional[Callable[..., Any]] = None,
        max_events: int = 5000,
    ) -> None:
        self.session_id = session_id
        self.logical_name = logical_name
        self.digest = digest
        self._client_factory = client_factory or PinnedRpcClient or RpcClient

        self.client: Optional[Any] = None
        self._start_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._closed: bool = False

        self.model: Optional[str] = None
        self.thinking: Optional[str] = None
        self.mode: Optional[str] = None

        self.session_settled: bool = True
        self.turn_active: bool = False

        # Sequenced event ring buffer
        self._max_events = max_events
        self._events: Deque[Dict[str, Any]] = deque(maxlen=max_events)
        self._event_seq: int = 0
        self._dropped_through: int = 0

        # Pending active requests
        self._pending_rpc_requests: Dict[str, Dict[str, Any]] = {}
        self._pending_ui_requests: Dict[str, Dict[str, Any]] = {}
        self._pending_host_tools: Dict[str, Dict[str, Any]] = {}
        self._pending_host_uris: Dict[str, Dict[str, Any]] = {}

    def is_running(self) -> bool:
        client = self.client
        if client is None or self._closed:
            return False
        proc = getattr(client, "_process", None)
        return proc is not None and proc.poll() is None

    def _on_raw_frame(self, frame: Dict[str, Any]) -> None:
        ftype = frame.get("type")
        with self._state_lock:
            # 1. Sequenced event ring buffer recording
            self._event_seq += 1
            if len(self._events) == self._max_events:
                self._dropped_through = self._events[0]["sequence"]

            record = {
                "sequence": self._event_seq,
                "event": frame,
            }
            self._events.append(record)

            # 2. Correlate and manage pending requests & state
            if ftype == "response":
                req_id = frame.get("id")
                if req_id and req_id in self._pending_rpc_requests:
                    cmd = self._pending_rpc_requests[req_id].get("type")
                    if cmd not in ("prompt", "abort_and_prompt"):
                        self._pending_rpc_requests.pop(req_id, None)
                    else:
                        # Local commands or immediate error responses clear ONLY their own pending ID.
                        # Do NOT blindly settle: another active run or background task may still be executing.
                        is_success = frame.get("success", False)
                        data = frame.get("data")
                        if not is_success or (isinstance(data, dict) and data.get("agentInvoked") is False):
                            self._pending_rpc_requests.pop(req_id, None)

                # Authoritative state update from native get_state response
                if frame.get("command") == "get_state" and frame.get("success"):
                    state_data = frame.get("data")
                    if isinstance(state_data, dict):
                        if "isSettled" in state_data:
                            self.session_settled = bool(state_data["isSettled"])
                        if "isStreaming" in state_data:
                            self.turn_active = bool(state_data["isStreaming"])

            elif ftype == "prompt_result":
                req_id = frame.get("id")
                if req_id:
                    self._pending_rpc_requests.pop(req_id, None)
                settled = frame.get("sessionSettled", frame.get("session_settled", False))
                if settled:
                    self.session_settled = True
                    self.turn_active = False

            elif ftype == "session_settled":
                self.session_settled = True
                self.turn_active = False
            elif ftype == "turn_start":
                self.turn_active = True
                self.session_settled = False

            elif ftype == "turn_end":
                self.turn_active = False

            elif ftype == "extension_ui_request":
                req_id = frame.get("id")
                method = frame.get("method")
                if method == "cancel":
                    target_id = frame.get("targetId") or req_id
                    if target_id:
                        self._pending_ui_requests.pop(target_id, None)
                elif req_id and method in ("confirm", "select", "input", "editor"):
                    self._pending_ui_requests[req_id] = frame

            elif ftype == "host_tool_call":
                req_id = frame.get("id")
                if req_id:
                    self._pending_host_tools[req_id] = frame

            elif ftype == "host_tool_cancel":
                target_id = frame.get("targetId")
                if target_id:
                    self._pending_host_tools.pop(target_id, None)

            elif ftype == "host_uri_request":
                req_id = frame.get("id")
                if req_id:
                    self._pending_host_uris[req_id] = frame

            elif ftype == "host_uri_cancel":
                target_id = frame.get("targetId")
                if target_id:
                    self._pending_host_uris.pop(target_id, None)

    def start_session(
        self,
        mode: str,
        session_id: Optional[str] = None,
        session_file: Optional[str] = None,
        cwd: Optional[str] = None,
        model: Optional[str] = None,
        thinking: Optional[str] = None,
    ) -> Any:
        with self._start_lock:
            if self._closed:
                raise RuntimeError(
                    f"Executor '{self.logical_name}' has been closed. Launch a new session."
                )
            if self.is_running():
                raise RuntimeError(f"Executor '{self.logical_name}' is already running")

            if self._client_factory is None:
                raise RuntimeError("omp_rpc library is not importable in environment")

            tunnel = get_tunnel_path()
            if not os.path.isfile(tunnel):
                raise RuntimeError(f"Tunnel helper script not found: {tunnel}")

            cmd = [
                sys.executable,
                tunnel,
                "--executor",
                self.digest,
                "--mode",
                mode,
            ]
            if session_id:
                cmd.extend(["--session-id", str(session_id)])
            if session_file:
                cmd.extend(["--session-file", str(session_file)])
            if cwd:
                cmd.extend(["--cwd", str(cwd)])
            if model is not None and str(model).strip():
                cmd.extend(["--model", str(model).strip()])
            if thinking is not None and str(thinking).strip():
                cmd.extend(["--thinking", str(thinking).strip()])
            client = self._client_factory(command=cmd, rpc_defaults=True)
            if hasattr(client, "set_raw_frame_callback"):
                client.set_raw_frame_callback(self._on_raw_frame)
            elif hasattr(client, "on_frame"):
                client.on_frame(self._on_raw_frame)

            try:
                client.start()
            except Exception:
                try:
                    client.stop()
                except Exception:
                    pass
                self.client = None
                raise

            self.client = client
            self.mode = mode
            self.model = model
            self.thinking = thinking
            return client

    def dispatch_rpc(self, command: str, params: Dict[str, Any]) -> str:
        client = self.client
        if client is None or not self.is_running():
            raise RuntimeError(f"Executor '{self.logical_name}' is not running")

        with self._state_lock:
            req_id = client._next_request_id()
            envelope = {"id": req_id, "type": command, **params}
            self._pending_rpc_requests[req_id] = envelope
            if command in ("prompt", "abort_and_prompt"):
                self.session_settled = False
                if hasattr(client, "_pending_prompt_ids") and isinstance(
                    client._pending_prompt_ids, set
                ):
                    client._pending_prompt_ids.add(req_id)

        try:
            proc = client._require_process()
            client._write_json(proc, envelope)
        except Exception:
            with self._state_lock:
                self._pending_rpc_requests.pop(req_id, None)
                if hasattr(client, "_pending_prompt_ids") and isinstance(
                    client._pending_prompt_ids, set
                ):
                    client._pending_prompt_ids.discard(req_id)
            raise

        return req_id

    def get_events_report(self, after: int, limit: int) -> Dict[str, Any]:
        with self._state_lock:
            dropped_through = self._dropped_through
            overflow = after < dropped_through

            effective_after = max(after, dropped_through)
            matching = [
                ev for ev in self._events if ev["sequence"] > effective_after
            ][:limit]

            next_cursor = matching[-1]["sequence"] if matching else after

            pending = (
                list(self._pending_rpc_requests.values())
                + list(self._pending_ui_requests.values())
                + list(self._pending_host_tools.values())
                + list(self._pending_host_uris.values())
            )

            res: Dict[str, Any] = {
                "ok": True,
                "executor": self.logical_name,
                "events": matching,
                "next_cursor": next_cursor,
                "dropped_through": dropped_through,
                "pending_requests": pending,
                "running": self.is_running(),
                "session_settled": self.session_settled,
                "turn_active": self.turn_active,
            }
            if overflow:
                res["overflow"] = True
                res["warning"] = (
                    f"Requested cursor {after} is older than dropped_through {dropped_through}"
                )
            return res

    def respond(self, response: Dict[str, Any]) -> Dict[str, Any]:
        client = self.client
        if client is None or not self.is_running():
            return {
                "ok": False,
                "error": f"Executor '{self.logical_name}' is not currently running",
            }

        req_id = response.get("id")
        if not req_id or not isinstance(req_id, str):
            return {
                "ok": False,
                "error": "Field 'id' must be a non-empty string",
            }

        resp_type = response.get("type")
        if not resp_type or not isinstance(resp_type, str):
            return {
                "ok": False,
                "error": "Field 'type' must be a valid native response type string",
            }

        # Atomic single-consumer: validate, send under lock, then pop. Failed send keeps pending.
        with self._state_lock:
            if resp_type == "extension_ui_response":
                if req_id not in self._pending_ui_requests:
                    return {
                        "ok": False,
                        "error": f"Stale or non-owned UI request id: '{req_id}'",
                    }
                pending_ui = self._pending_ui_requests[req_id]
                method = pending_ui.get("method")
                options = list(pending_ui.get("options") or [])

                if response.get("cancelled") is True:
                    if "timedOut" in response and not isinstance(response["timedOut"], bool):
                        return {"ok": False, "error": "'timedOut' must be a boolean"}
                    payload: Dict[str, Any] = {
                        "type": "extension_ui_response",
                        "id": req_id,
                        "cancelled": True,
                    }
                    if response.get("timedOut") is True:
                        payload["timedOut"] = True
                elif method == "confirm":
                    if "confirmed" not in response or not isinstance(response["confirmed"], bool):
                        return {
                            "ok": False,
                            "error": "confirm UI response requires strict boolean 'confirmed'",
                        }
                    payload = {
                        "type": "extension_ui_response",
                        "id": req_id,
                        "confirmed": response["confirmed"],
                    }
                elif method == "select":
                    val = response.get("value")
                    if val is None or not isinstance(val, str):
                        return {
                            "ok": False,
                            "error": "select UI response requires string 'value'",
                        }
                    if options and val not in options:
                        return {
                            "ok": False,
                            "error": f"Selected value '{val}' is not in offered options: {options}",
                        }
                    payload = {
                        "type": "extension_ui_response",
                        "id": req_id,
                        "value": val,
                    }
                elif method in ("input", "editor"):
                    val = response.get("value")
                    if val is None or not isinstance(val, str):
                        return {
                            "ok": False,
                            "error": f"{method} UI response requires string 'value'",
                        }
                    payload = {
                        "type": "extension_ui_response",
                        "id": req_id,
                        "value": val,
                    }
                else:
                    return {
                        "ok": False,
                        "error": f"Cannot respond to passive or unsupported UI method '{method}'",
                    }

                client._send_notification(payload)
                self._pending_ui_requests.pop(req_id, None)
                return {
                    "ok": True,
                    "executor": self.logical_name,
                    "request_id": req_id,
                    "type": resp_type,
                }

            elif resp_type == "host_tool_update":
                if req_id not in self._pending_host_tools:
                    return {
                        "ok": False,
                        "error": f"Stale or non-owned host tool request id: '{req_id}'",
                    }
                if "partialResult" not in response:
                    return {
                        "ok": False,
                        "error": "host_tool_update requires 'partialResult' object",
                    }
                partial_res = response["partialResult"]
                if not isinstance(partial_res, dict):
                    return {
                        "ok": False,
                        "error": "host_tool_update 'partialResult' must be an object",
                    }
                payload = {
                    "type": "host_tool_update",
                    "id": req_id,
                    "partialResult": partial_res,
                }
                # Update preserves pending ID in _pending_host_tools
                client._send_notification(payload)
                return {
                    "ok": True,
                    "executor": self.logical_name,
                    "request_id": req_id,
                    "type": resp_type,
                }

            elif resp_type == "host_tool_result":
                if req_id not in self._pending_host_tools:
                    return {
                        "ok": False,
                        "error": f"Stale or non-owned host tool request id: '{req_id}'",
                    }
                is_error = response.get("isError", False)
                if not isinstance(is_error, bool):
                    return {"ok": False, "error": "'isError' must be a boolean"}

                if "result" not in response and not is_error:
                    return {
                        "ok": False,
                        "error": "host_tool_result requires 'result' object",
                    }
                res_val = response.get("result", {})
                if not isinstance(res_val, dict):
                    return {
                        "ok": False,
                        "error": "host_tool_result 'result' must be an object",
                    }

                payload = {
                    "type": "host_tool_result",
                    "id": req_id,
                    "result": res_val,
                }
                if is_error:
                    payload["isError"] = True

                client._send_notification(payload)
                self._pending_host_tools.pop(req_id, None)
                return {
                    "ok": True,
                    "executor": self.logical_name,
                    "request_id": req_id,
                    "type": resp_type,
                }

            elif resp_type == "host_uri_result":
                if req_id not in self._pending_host_uris:
                    return {"ok": False, "error": f"Stale or non-owned host URI request id: '{req_id}'"}
                is_error = response.get("isError", False)
                if not isinstance(is_error, bool):
                    return {"ok": False, "error": "'isError' must be a boolean"}
                if "error" in response and not isinstance(response["error"], str):
                    return {"ok": False, "error": "'error' must be a string"}
                if is_error:
                    if not isinstance(response.get("error", response.get("content")), str):
                        return {"ok": False, "error": "Host URI errors require text in 'error' or 'content'"}
                elif self._pending_host_uris[req_id]["operation"] == "read":
                    if not isinstance(response.get("content"), str):
                        return {"ok": False, "error": "Host URI reads require string 'content'"}
                if "contentType" in response and response["contentType"] not in (
                    "text/plain", "text/markdown", "application/json"
                ):
                    return {"ok": False, "error": "Unsupported host URI contentType"}
                if "notes" in response and (
                    not isinstance(response["notes"], list)
                    or not all(isinstance(note, str) for note in response["notes"])
                ):
                    return {"ok": False, "error": "'notes' must be an array of strings"}
                if "immutable" in response and not isinstance(response["immutable"], bool):
                    return {"ok": False, "error": "'immutable' must be a boolean"}
                client._send_notification(dict(response))
                self._pending_host_uris.pop(req_id, None)
                return {
                    "ok": True,
                    "executor": self.logical_name,
                    "request_id": req_id,
                    "type": resp_type,
                }

            else:
                return {
                    "ok": False,
                    "error": (
                        f"Unsupported response type '{resp_type}'. Must be extension_ui_response, "
                        "host_tool_update, host_tool_result, or host_uri_result"
                    ),
                }

    def close(self) -> None:
        with self._start_lock:
            self._closed = True
            client = self.client
            self.client = None
            with self._state_lock:
                self.turn_active = False
                self.session_settled = True
                self._pending_rpc_requests.clear()
                self._pending_ui_requests.clear()
                self._pending_host_tools.clear()
                self._pending_host_uris.clear()
            if client is not None:
                try:
                    client.stop()
                except Exception as exc:
                    logger.debug("Client stop error for %s: %s", self.digest, exc)


# ---------------------------------------------------------------------------
# Session Registry
# ---------------------------------------------------------------------------

class SessionRegistry:
    """Tracks active ExecutorSession instances by Hermes session ID and logical name."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, ExecutorSession] = {}
        self._by_session_id: Dict[str, Set[str]] = {}
        self._factory_override: Optional[Callable[..., Any]] = None

    def set_client_factory(self, factory: Optional[Callable[..., Any]]) -> None:
        self._factory_override = factory

    def get_or_create(self, session_id: str, logical_name: str) -> ExecutorSession:
        digest = derive_executor_id(session_id, logical_name)
        with self._lock:
            session = self._sessions.get(digest)
            if session is None or session._closed:
                session = ExecutorSession(
                    session_id=session_id,
                    logical_name=logical_name,
                    digest=digest,
                    client_factory=self._factory_override,
                )
                self._sessions[digest] = session
                self._by_session_id.setdefault(session_id, set()).add(digest)
            return session

    def get(self, session_id: str, logical_name: str) -> Optional[ExecutorSession]:
        digest = derive_executor_id(session_id, logical_name)
        with self._lock:
            session = self._sessions.get(digest)
            if session is not None and not session._closed:
                return session
            return None

    def close_session(self, session_id: str, logical_name: str) -> None:
        digest = derive_executor_id(session_id, logical_name)
        with self._lock:
            session = self._sessions.pop(digest, None)
            if session_id in self._by_session_id:
                self._by_session_id[session_id].discard(digest)
                if not self._by_session_id[session_id]:
                    self._by_session_id.pop(session_id, None)
        if session is not None:
            session.close()

    def close_hermes_session(self, session_id: str) -> None:
        if not session_id:
            return
        with self._lock:
            digests = list(self._by_session_id.pop(session_id, set()))
            sessions = [self._sessions.pop(d, None) for d in digests]
        for s in sessions:
            if s is not None:
                s.close()

    def close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            self._by_session_id.clear()
        for s in sessions:
            s.close()


registry = SessionRegistry()
atexit.register(registry.close_all)


# ---------------------------------------------------------------------------
# Tool Handlers
# ---------------------------------------------------------------------------

def handle_sessions(args: dict, session_id: str = "", **kwargs: Any) -> Dict[str, Any]:
    """List native OMP sessions from catalog via the tunnel transport."""
    if not session_id:
        return {"ok": False, "error": "Missing trusted session_id in execution context"}

    offset_raw = args.get("offset", 0)
    limit_raw = args.get("limit", 50)
    try:
        offset = int(offset_raw)
        if offset < 0:
            return {"ok": False, "error": "Offset must be >= 0"}
    except (ValueError, TypeError):
        return {"ok": False, "error": f"Invalid offset: {offset_raw}"}

    try:
        limit = int(limit_raw)
        if limit < 1 or limit > 100:
            return {"ok": False, "error": "Limit must be between 1 and 100"}
    except (ValueError, TypeError):
        return {"ok": False, "error": f"Invalid limit: {limit_raw}"}

    tunnel = get_tunnel_path()
    if not os.path.isfile(tunnel):
        return {"ok": False, "error": f"Tunnel helper script not found: {tunnel}"}

    cmd = [
        sys.executable,
        tunnel,
        "--list-sessions",
        "--offset",
        str(offset),
        "--limit",
        str(limit),
    ]

    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15.0,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Timed out waiting for catalog session listing"}
    except Exception as exc:
        return {"ok": False, "error": f"Failed to execute tunnel catalog listing: {exc}"}

    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or f"exit code {proc.returncode}"
        return {"ok": False, "error": f"Catalog session listing failed: {err}"}

    try:
        payload = json.loads(proc.stdout.strip())
    except Exception as exc:
        return {"ok": False, "error": f"Malformed catalog response: {exc}"}

    if not isinstance(payload, dict):
        return {"ok": False, "error": "Catalog response must be a JSON object"}

    if payload.get("type") == "transport_error":
        return {"ok": False, "error": str(payload.get("error") or "Transport error")}

    sessions = payload.get("sessions")
    if not isinstance(sessions, list):
        return {"ok": False, "error": "Catalog response missing 'sessions' list"}

    return {
        "ok": True,
        "sessions": sessions,
        "total": payload.get("total", len(sessions)),
        "offset": payload.get("offset", offset),
        "limit": payload.get("limit", limit),
    }


def handle_open(args: dict, session_id: str = "", **kwargs: Any) -> Dict[str, Any]:
    """Establish an isolated OMP executor connection without sending a prompt."""
    if not session_id:
        return {"ok": False, "error": "Missing trusted session_id in execution context"}

    name = str(args.get("executor") or "default").strip()
    ok, err = validate_executor_name(name)
    if not ok:
        return {"ok": False, "error": err}

    mode = str(args.get("mode") or "").strip().lower()
    if mode not in {"new", "resume"}:
        return {"ok": False, "error": f"Mode must be 'new' or 'resume', got: '{mode}'"}

    target_session_id = args.get("session_id")
    target_session_file = args.get("session_file")
    raw_cwd = args.get("cwd")
    cwd: Optional[str] = None
    if raw_cwd is not None:
        if not isinstance(raw_cwd, str) or not raw_cwd.strip():
            return {"ok": False, "error": "Field 'cwd' must be a non-empty string"}
        cwd = raw_cwd.strip()
        if not os.path.isabs(cwd):
            return {
                "ok": False,
                "error": f"Field 'cwd' must be an absolute path: '{cwd}'",
            }

    if mode == "new":
        if target_session_id or target_session_file:
            return {
                "ok": False,
                "error": "Mode 'new' does not accept session_id or session_file selectors",
            }
    elif mode == "resume":
        if cwd is not None:
            return {
                "ok": False,
                "error": "Mode 'resume' rejects cwd override (working directory is recovered from session header)",
            }
        if not target_session_id and not target_session_file:
            return {
                "ok": False,
                "error": "Mode 'resume' requires session_id or session_file selector",
            }

    existing = registry.get(session_id, name)
    if existing is not None and existing.is_running():
        return {
            "ok": False,
            "error": (
                f"Executor '{name}' is already running. "
                "Use omp_close before opening a new session, or switch_session/new_session via omp_rpc."
            ),
        }

    if existing is not None:
        registry.close_session(session_id, name)

    session = registry.get_or_create(session_id, name)
    try:
        session.start_session(
            mode=mode,
            session_id=target_session_id,
            session_file=target_session_file,
            cwd=cwd,
            model=args.get("model"),
            thinking=args.get("thinking"),
        )
        return {
            "ok": True,
            "executor": name,
            "mode": mode,
            "running": True,
        }
    except Exception as exc:
        registry.close_session(session_id, name)
        return {"ok": False, "error": f"Failed to open OMP executor: {exc}"}


def handle_rpc(args: dict, session_id: str = "", **kwargs: Any) -> Dict[str, Any]:
    """Dispatch any native RpcCommand asynchronously and return immediately."""
    if not session_id:
        return {"ok": False, "error": "Missing trusted session_id in execution context"}

    name = str(args.get("executor") or "default").strip()
    ok, err = validate_executor_name(name)
    if not ok:
        return {"ok": False, "error": err}

    command = args.get("command")
    if not command or not isinstance(command, str):
        return {"ok": False, "error": "Field 'command' must be a non-empty string"}

    command = command.strip()
    if command not in SUPPORTED_COMMANDS:
        return {
            "ok": False,
            "error": (
                f"Unknown RpcCommand '{command}'. Supported native commands ({len(SUPPORTED_COMMANDS)}): "
                f"{sorted(SUPPORTED_COMMANDS)}"
            ),
        }

    session = registry.get(session_id, name)
    if session is None or not session.is_running():
        return {
            "ok": False,
            "error": f"Executor '{name}' is not currently running. Use omp_open first.",
        }

    raw_params = args.get("params")
    if raw_params is None:
        params: Dict[str, Any] = {}
    elif not isinstance(raw_params, dict):
        return {"ok": False, "error": "Field 'params' must be an object"}
    else:
        params = dict(raw_params)

    # Reject caller attempting to override reserved id/type
    if "id" in params or "type" in params:
        return {
            "ok": False,
            "error": "Reserved field 'id' or 'type' cannot be provided in params",
        }

    try:
        req_id = session.dispatch_rpc(command, params)
        return {
            "ok": True,
            "executor": name,
            "request_id": req_id,
            "submitted": True,
        }
    except Exception as exc:
        return {"ok": False, "error": f"RPC submission failed: {exc}"}


def handle_events(args: dict, session_id: str = "", **kwargs: Any) -> Dict[str, Any]:
    """Retrieve sequenced bounded event replay, pending requests, and execution state."""
    if not session_id:
        return {"ok": False, "error": "Missing trusted session_id in execution context"}

    name = str(args.get("executor") or "default").strip()
    ok, err = validate_executor_name(name)
    if not ok:
        return {"ok": False, "error": err}

    after_raw = args.get("after", 0)
    limit_raw = args.get("limit", 100)
    try:
        after = int(after_raw)
        if after < 0:
            return {"ok": False, "error": "Field 'after' must be >= 0"}
    except (ValueError, TypeError):
        return {"ok": False, "error": f"Invalid 'after' cursor: {after_raw}"}

    try:
        limit = min(max(int(limit_raw), 1), 1000)
    except (ValueError, TypeError):
        return {"ok": False, "error": f"Invalid 'limit': {limit_raw}"}

    session = registry.get(session_id, name)
    if session is None:
        return {
            "ok": True,
            "executor": name,
            "running": False,
            "session_settled": True,
            "turn_active": False,
            "events": [],
            "next_cursor": after,
            "dropped_through": 0,
            "pending_requests": [],
        }

    return session.get_events_report(after=after, limit=limit)


def handle_respond(args: dict, session_id: str = "", **kwargs: Any) -> Dict[str, Any]:
    """Respond to or update active UI requests, host tool calls, or host URI requests."""
    if not session_id:
        return {"ok": False, "error": "Missing trusted session_id in execution context"}

    name = str(args.get("executor") or "default").strip()
    ok, err = validate_executor_name(name)
    if not ok:
        return {"ok": False, "error": err}

    response = args.get("response")
    if not isinstance(response, dict):
        return {"ok": False, "error": "Field 'response' must be an object"}

    session = registry.get(session_id, name)
    if session is None or not session.is_running():
        return {
            "ok": False,
            "error": f"Executor '{name}' is not currently running",
        }

    try:
        return session.respond(response)
    except Exception as exc:
        return {"ok": False, "error": f"Response submission failed: {exc}"}


def handle_close(args: dict, session_id: str = "", **kwargs: Any) -> Dict[str, Any]:
    """Explicitly stop and close an OMP executor connection and process."""
    if not session_id:
        return {"ok": False, "error": "Missing trusted session_id in execution context"}

    name = str(args.get("executor") or "default").strip()
    ok, err = validate_executor_name(name)
    if not ok:
        return {"ok": False, "error": err}

    registry.close_session(session_id, name)
    return {"ok": True, "executor": name, "closed": True}


# ---------------------------------------------------------------------------
# Declarations
# ---------------------------------------------------------------------------

TOOL_DEFINITIONS = (
    (
        "omp_sessions",
        {
            "name": "omp_sessions",
            "description": (
                "List available native OMP sessions across workspace and ~/.omp/agent/sessions catalogs. "
                "Returns session identifiers, files, names, modified timestamps, and working directories."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "offset": {
                        "type": "integer",
                        "description": "Pagination offset (default 0).",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max sessions to return between 1 and 100 (default 50).",
                    },
                },
            },
        },
        handle_sessions,
        "📋",
    ),
    (
        "omp_open",
        {
            "name": "omp_open",
            "description": (
                "Establish an isolated OMP executor connection without sending a prompt. "
                "Mode 'new' starts a fresh native session in workspace; mode 'resume' connects an exact "
                "indexed session by session_id or session_file, preserving its recorded working directory."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "executor": {
                        "type": "string",
                        "description": "Logical executor name (default 'default').",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["new", "resume"],
                        "description": "Mandatory session mode: 'new' or 'resume'.",
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Target native session ID (mandatory for resume if session_file omitted).",
                    },
                    "session_file": {
                        "type": "string",
                        "description": "Target catalog session file path (mandatory for resume if session_id omitted).",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional absolute working directory for mode 'new' only. Mode 'resume' recovers cwd from session header and rejects cwd override.",
                    },
                    "model": {
                        "type": "string",
                        "description": "Launch model override (e.g. 'claude-3-5-sonnet-20241022').",
                    },
                    "thinking": {
                        "type": "string",
                        "description": "Launch thinking level override (e.g. 'high', 'medium', 'low', 'off').",
                    },
                },
                "required": ["mode"],
            },
        },
        handle_open,
        "🚀",
    ),
    (
        "omp_rpc",
        {
            "name": "omp_rpc",
            "description": (
                "Dispatch ANY native OMP RpcCommand asynchronously and return immediately with correlated request_id.\n"
                "All 48 native commands and argument shapes:\n"
                "  - Protocol: negotiate_protocol {protocolVersion: int}\n"
                "  - Prompting: prompt {message: str, images?: list, streamingBehavior?: 'steer'|'followUp'} (supports slash commands & images);\n"
                "    steer {message: str, images?: list}; follow_up {message: str, images?: list};\n"
                "    remove_queued_message {message: str, queue: 'steering'|'followUp'}; abort {};\n"
                "    abort_and_prompt {message: str, images?: list}; new_session {parentSession?: str};\n"
                "    open_session {sessionDir: str}\n"
                "  - State & Tools: get_state {}; set_fast_mode {enabled: bool}; get_available_commands {};\n"
                "    get_entries {since?: str}; get_tree {}; set_todos {phases: list}; set_host_tools {tools: list};\n"
                "    set_host_uri_schemes {schemes: list}; set_subagent_subscription {level: 'off'|'progress'|'events'};\n"
                "    set_event_filter {events: list[str] | null} (null clears filter); get_subagents {};\n"
                "    get_subagent_messages {subagentId?: str, sessionFile?: str, fromByte?: int}\n"
                "  - Model & Thinking: set_model {provider: str, modelId: str}; cycle_model {}; get_available_models {};\n"
                "    set_thinking_level {level: str (use get_available_thinking_levels)}; cycle_thinking_level {};\n"
                "    get_available_thinking_levels {}\n"
                "  - Queue & Interrupt: set_steering_mode {mode: 'all'|'one-at-a-time'};\n"
                "    set_follow_up_mode {mode: 'all'|'one-at-a-time'}; set_interrupt_mode {mode: 'immediate'|'wait'}\n"
                "  - Compaction & Retry: compact {customInstructions?: str}; set_auto_compaction {enabled: bool};\n"
                "    set_auto_retry {enabled: bool}; abort_retry {}\n"
                "  - Bash: bash {command: str}; abort_bash {}\n"
                "  - Session: get_session_stats {}; export_html {outputPath?: str}; switch_session {sessionPath: str};\n"
                "    branch {entryId: str}; get_branch_messages {}; get_last_assistant_text {}; set_session_name {name: str};\n"
                "    handoff {customInstructions?: str}\n"
                "  - Messages: get_messages {}; get_messages_page {cursor?: str, limit?: int}\n"
                "  - Login: get_login_providers {}; login {providerId: str}\n"
                "Note: Headless RPC cannot accept interactive OAuth secret credentials. OAuth providers will emit "
                "authorization URLs in events or fail if terminal secret input is required."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "executor": {
                        "type": "string",
                        "description": "Logical executor name (default 'default').",
                    },
                    "command": {
                        "type": "string",
                        "description": "Native RpcCommand type (e.g. 'prompt', 'steer', 'abort', 'get_state', 'bash', 'compact').",
                    },
                    "params": {
                        "type": "object",
                        "description": "Native command parameters matching OMP TypeScript protocol schema. Reserved id/type cannot be passed.",
                    },
                },
                "required": ["command"],
            },
        },
        handle_rpc,
        "⚡",
    ),
    (
        "omp_events",
        {
            "name": "omp_events",
            "description": (
                "Retrieve sequenced bounded event replay, pending requests, and settlement status for an executor. "
                "Non-destructive replay using cursor 'after'. Returns responses, prompt results, agent turn events, "
                "UI requests, and host tool calls."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "executor": {
                        "type": "string",
                        "description": "Logical executor name (default 'default').",
                    },
                    "after": {
                        "type": "integer",
                        "description": "Sequence cursor: returns events strictly after this sequence number (default 0).",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max events to return up to 1000 (default 100).",
                    },
                },
            },
        },
        handle_events,
        "📡",
    ),
    (
        "omp_respond",
        {
            "name": "omp_respond",
            "description": (
                "Respond to or update active interactive UI requests, host tool calls, or host URI requests. "
                "Requires exact native response types:\n"
                "  - extension_ui_response: {type: 'extension_ui_response', id: str, confirmed?: bool, value?: str, cancelled?: bool, timedOut?: bool}\n"
                "  - host_tool_update: {type: 'host_tool_update', id: str, partialResult: object} (preserves pending ID)\n"
                "  - host_tool_result: {type: 'host_tool_result', id: str, result?: object, isError?: bool}\n"
                "  - host_uri_result: {type: 'host_uri_result', id: str, content?: list|str, contentType?: str, notes?: str, immutable?: bool, isError?: bool, error?: str}\n"
                "Stale or mismatched requests are rejected under state lock without consuming valid requests."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "executor": {
                        "type": "string",
                        "description": "Logical executor name (default 'default').",
                    },
                    "response": {
                        "type": "object",
                        "description": "Native response object matching extension_ui_response, host_tool_update, host_tool_result, or host_uri_result.",
                    },
                },
                "required": ["response"],
            },
        },
        handle_respond,
        "💬",
    ),
    (
        "omp_close",
        {
            "name": "omp_close",
            "description": (
                "Explicitly stop and close an OMP executor connection and process, retaining durable session history."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "executor": {
                        "type": "string",
                        "description": "Logical executor name (default 'default').",
                    },
                },
            },
        },
        handle_close,
        "🔒",
    ),
)
