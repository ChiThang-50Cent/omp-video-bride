#!/usr/bin/env python3
"""Behavioral regressions for trusted executor ownership, native result/settlement
transitions, bounded event replay and explicit UI/host request validation.

Real native routing, session selection and restoration are exercised by
tools/smoke-executor.py in the pinned Docker runtime.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "hermes-plugin" / "omp-executor"
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import executor
from executor import (
    ExecutorSession,
    SessionRegistry,
    derive_executor_id,
    handle_close,
    handle_events,
    handle_open,
    handle_respond,
    handle_rpc,
    handle_sessions,
    validate_executor_name,
)


class FakeStdin:
    def __init__(self, on_write: Optional[Callable[[str], None]] = None) -> None:
        self.written: List[str] = []
        self._on_write = on_write

    def write(self, s: str) -> int:
        self.written.append(s)
        if self._on_write:
            self._on_write(s)
        return len(s)

    def flush(self) -> None:
        pass


class FakeProcess:
    def __init__(self, running: bool = True, on_write: Optional[Callable[[str], None]] = None) -> None:
        self._running = running
        self.stdin = FakeStdin(on_write=on_write)

    def poll(self) -> Optional[int]:
        return None if self._running else 0


class FakeRpcClient:
    """Mock RpcClient modeling the native client contract without network/subprocesses."""

    def __init__(
        self,
        fail_startup: bool = False,
        fail_write: bool = False,
        command: Optional[Sequence[str]] = None,
        **kwargs: Any,
    ) -> None:
        self.fail_startup = fail_startup
        self.fail_write = fail_write
        self.command = list(command) if command else []
        self._process = FakeProcess(running=False, on_write=self._on_stdin_write)
        self._next_id = 0
        self._pending_prompt_ids: Set[str] = set()
        self._raw_frame_cb: Optional[Callable[[Dict[str, Any]], None]] = None

    def _on_stdin_write(self, s: str) -> None:
        pass

    def start(self) -> FakeRpcClient:
        if self.fail_startup:
            raise RuntimeError("Transport connection refused")
        self._process = FakeProcess(running=True, on_write=self._on_stdin_write)
        return self

    def stop(self) -> None:
        self._process = FakeProcess(running=False)

    def _require_process(self) -> FakeProcess:
        return self._process

    def _next_request_id(self) -> str:
        self._next_id += 1
        return f"req_{self._next_id}"

    def _write_json(self, proc: Any, envelope: Dict[str, Any]) -> None:
        if self.fail_write:
            raise RuntimeError("Broken pipe on write_json")

    def _send_notification(self, payload: Dict[str, Any]) -> None:
        if self.fail_write:
            raise RuntimeError("Broken pipe on send_notification")

    def on_frame(self, cb: Callable[[Dict[str, Any]], None]) -> None:
        self._raw_frame_cb = cb

    def set_raw_frame_callback(self, cb: Callable[[Dict[str, Any]], None]) -> None:
        self._raw_frame_cb = cb

    def emit_frame(self, frame: Dict[str, Any]) -> None:
        if self._raw_frame_cb is not None:
            self._raw_frame_cb(dict(frame))


class TestHermesOmpPluginBehavior(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = SessionRegistry()
        executor.registry = self.registry
        self.last_client: Optional[FakeRpcClient] = None

        def factory(**kwargs: Any) -> FakeRpcClient:
            client = FakeRpcClient(**kwargs)
            self.last_client = client
            return client

        self.registry.set_client_factory(factory)

    def tearDown(self) -> None:
        self.registry.close_all()

    # -----------------------------------------------------------------------
    # 1. Missing session_id Refusal Across All 6 Tools
    # -----------------------------------------------------------------------
    def test_missing_session_id_refusal(self) -> None:
        cases = [
            (handle_sessions, {}),
            (handle_open, {"mode": "new"}),
            (handle_rpc, {"command": "get_state"}),
            (handle_events, {}),
            (handle_respond, {"response": {"type": "extension_ui_response", "id": "1", "confirmed": True}}),
            (handle_close, {}),
        ]
        for fn, args in cases:
            res = fn(args, session_id="")
            self.assertFalse(res["ok"], f"Expected refusal for {fn.__name__}")
            self.assertIn("error", res)


    # -----------------------------------------------------------------------
    # 2. Executor Name Validation
    # -----------------------------------------------------------------------
    def test_executor_name_validation(self) -> None:
        ok, err = validate_executor_name("default")
        self.assertTrue(ok)


        ok, err = validate_executor_name("subagent_1.task-worker")
        self.assertTrue(ok)

        ok, err = validate_executor_name("")
        self.assertFalse(ok)

        ok, err = validate_executor_name("bad name with spaces")
        self.assertFalse(ok)

        ok, err = validate_executor_name("a" * 65)
        self.assertFalse(ok)

    # -----------------------------------------------------------------------
    # 3. omp_sessions Catalog Discovery
    # -----------------------------------------------------------------------


    def test_sessions_catalog_argument_bounds(self) -> None:
        res_bad_offset = handle_sessions({"offset": -5}, session_id="sess-A")
        self.assertFalse(res_bad_offset["ok"])


        res_bad_limit = handle_sessions({"limit": 0}, session_id="sess-A")
        self.assertFalse(res_bad_limit["ok"])


        res_bad_limit_high = handle_sessions({"limit": 105}, session_id="sess-A")
        self.assertFalse(res_bad_limit_high["ok"])


    # -----------------------------------------------------------------------
    # 4. omp_open: Mode 'new' vs 'resume' and Validation
    # -----------------------------------------------------------------------
    def test_open_mode_validation(self) -> None:
        # Missing mode
        res_missing = handle_open({}, session_id="sess-A")
        self.assertFalse(res_missing["ok"])


        # Invalid mode
        res_invalid = handle_open({"mode": "auto"}, session_id="sess-A")
        self.assertFalse(res_invalid["ok"])


        # Mode 'new' with selector rejected
        res_new_with_id = handle_open(
            {"mode": "new", "session_id": "uuid-123"}, session_id="sess-A"
        )
        self.assertFalse(res_new_with_id["ok"])


        # Mode 'resume' without selector rejected
        res_resume_no_sel = handle_open({"mode": "resume"}, session_id="sess-A")
        self.assertFalse(res_resume_no_sel["ok"])






    def test_open_already_running_refusal(self) -> None:
        res1 = handle_open({"mode": "new", "executor": "worker"}, session_id="sess-A")
        self.assertTrue(res1["ok"])

        # Second open without omp_close must fail
        res2 = handle_open({"mode": "new", "executor": "worker"}, session_id="sess-A")
        self.assertFalse(res2["ok"])


    def test_open_cwd_validation(self) -> None:
        # Relative cwd rejected
        res_rel = handle_open({"mode": "new", "cwd": "relative/path"}, session_id="sess-A")
        self.assertFalse(res_rel["ok"])


        # Empty cwd rejected
        res_empty = handle_open({"mode": "new", "cwd": "   "}, session_id="sess-A")
        self.assertFalse(res_empty["ok"])


        # Resume mode rejects cwd override
        res_resume_cwd = handle_open(
            {"mode": "resume", "session_id": "uuid-1", "cwd": "/workspace/proj"},
            session_id="sess-A",
        )
        self.assertFalse(res_resume_cwd["ok"])


        # Valid absolute cwd in new mode
        res_valid = handle_open(
            {"mode": "new", "executor": "proj_worker", "cwd": "/workspace/proj-alpha"},
            session_id="sess-A",
        )
        self.assertTrue(res_valid["ok"])
        self.assertTrue(res_valid["running"])

    # -----------------------------------------------------------------------
    # 5. omp_rpc: Asynchronous Dispatch, Supported Commands, Null Preservation
    # -----------------------------------------------------------------------
    def test_rpc_requires_running_executor(self) -> None:
        res = handle_rpc({"command": "get_state"}, session_id="sess-A")
        self.assertFalse(res["ok"])


    def test_rpc_rejects_unknown_command(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        res = handle_rpc({"command": "invalid_custom_command"}, session_id="sess-A")
        self.assertFalse(res["ok"])




    def test_rpc_rejects_reserved_id_and_type(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")

        # Attempt to pass reserved id or type must be rejected
        res_bad_id = handle_rpc(
            {"command": "get_state", "params": {"id": "ATTEMPTED_OVERRIDE"}},
            session_id="sess-A",
        )
        self.assertFalse(res_bad_id["ok"])


        res_bad_type = handle_rpc(
            {"command": "get_state", "params": {"type": "OVERRIDE"}},
            session_id="sess-A",
        )
        self.assertFalse(res_bad_type["ok"])



    def test_rpc_async_immediate_return_and_pending_tracking(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        # Dispatch long bash command
        res = handle_rpc({"command": "bash", "params": {"command": "sleep 10"}}, session_id="sess-A")
        self.assertTrue(res["ok"])
        req_id = res["request_id"]
        self.assertTrue(res["submitted"])

        # Check pending requests via omp_events
        ev_report = handle_events({}, session_id="sess-A")
        self.assertTrue(ev_report["ok"])
        pending_ids = [p.get("id") for p in ev_report["pending_requests"]]
        self.assertIn(req_id, pending_ids)

        # Emit native response frame from stdout
        client.emit_frame({
            "id": req_id,
            "type": "response",
            "command": "bash",
            "success": True,
            "data": {"stdout": "", "stderr": "", "exitCode": 0},
        })

        # Pending request should now be completed and cleared
        ev_report2 = handle_events({}, session_id="sess-A")
        pending_ids2 = [p.get("id") for p in ev_report2["pending_requests"]]
        self.assertNotIn(req_id, pending_ids2)

    def test_rpc_write_failure_clears_pending(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)
        client.fail_write = True

        res = handle_rpc({"command": "get_state"}, session_id="sess-A")
        self.assertFalse(res["ok"])


        # Nothing should remain pending
        ev = handle_events({}, session_id="sess-A")
        self.assertEqual(len(ev["pending_requests"]), 0)

    # -----------------------------------------------------------------------
    # 6. omp_events: Sequenced Replay, Overflow, and Overlapping Run Lifecycles
    # -----------------------------------------------------------------------
    def test_events_sequenced_monotonic_replay(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        client.emit_frame({"type": "ready", "protocolVersion": 1})
        client.emit_frame({"type": "turn_start", "turnIndex": 1})
        client.emit_frame({"type": "message_start", "role": "assistant"})
        client.emit_frame({"type": "turn_end", "turnIndex": 1})

        res = handle_events({"after": 0, "limit": 10}, session_id="sess-A")
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["events"]), 4)
        self.assertEqual(res["events"][0]["sequence"], 1)
        self.assertEqual(res["events"][0]["event"]["type"], "ready")
        self.assertEqual(res["events"][3]["sequence"], 4)
        self.assertEqual(res["next_cursor"], 4)
        self.assertEqual(res["dropped_through"], 0)

        res_after = handle_events({"after": 2, "limit": 10}, session_id="sess-A")
        self.assertEqual(len(res_after["events"]), 2)
        self.assertEqual(res_after["events"][0]["sequence"], 3)
        self.assertEqual(res_after["events"][1]["sequence"], 4)
        self.assertEqual(res_after["next_cursor"], 4)

    def test_events_overflow_gap_detection(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        session = self.registry.get("sess-A", "default")
        self.assertIsNotNone(session)
        session._max_events = 3
        session._events = executor.deque(maxlen=3)

        client = self.last_client
        self.assertIsNotNone(client)

        for i in range(1, 6):
            client.emit_frame({"type": "test_event", "index": i})

        # Evicted sequences 1 and 2
        self.assertEqual(session._dropped_through, 2)

        res = handle_events({"after": 0}, session_id="sess-A")
        self.assertTrue(res["ok"])
        self.assertTrue(res.get("overflow", False))
        self.assertIn("warning", res)
        self.assertEqual(res["dropped_through"], 2)
        self.assertEqual(len(res["events"]), 3)
        self.assertEqual(res["events"][0]["sequence"], 3)

    def test_overlapping_prompts_and_local_or_error_completion_lifecycle(self) -> None:
        """Verify that local-only (/model) or immediate error completion clears only its own

        pending ID and does NOT falsely settle another active run or background job.
        Authoritative state updates occur via native get_state, prompt_result, or session_settled.
        """
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        # 1. Start active prompt 1
        res1 = handle_rpc({"command": "prompt", "params": {"message": "long running task"}}, session_id="sess-A")
        req1 = res1["request_id"]
        client.emit_frame({"type": "turn_start", "turnIndex": 1})

        ev1 = handle_events({}, session_id="sess-A")
        self.assertIn(req1, [p["id"] for p in ev1["pending_requests"]])
        self.assertTrue(ev1["turn_active"])
        self.assertFalse(ev1["session_settled"])

        # 2. Overlapping local command (/model) finishes locally with agentInvoked: false
        res2 = handle_rpc({"command": "prompt", "params": {"message": "/model"}}, session_id="sess-A")
        req2 = res2["request_id"]
        client.emit_frame({
            "id": req2,
            "type": "response",
            "command": "prompt",
            "success": True,
            "data": {"agentInvoked": False},
        })

        # req2 cleared, but req1 STILL active and session NOT falsely settled!
        ev2 = handle_events({}, session_id="sess-A")
        pending_ids2 = [p["id"] for p in ev2["pending_requests"]]
        self.assertNotIn(req2, pending_ids2)
        self.assertIn(req1, pending_ids2)
        self.assertTrue(ev2["turn_active"])
        self.assertFalse(ev2["session_settled"])

        # 3. Overlapping bad prompt fails immediately with error response
        res3 = handle_rpc({"command": "prompt", "params": {"message": "invalid syntax"}}, session_id="sess-A")
        req3 = res3["request_id"]
        client.emit_frame({
            "id": req3,
            "type": "response",
            "command": "prompt",
            "success": False,
            "error": "Syntax error",
            "code": "invalid_syntax",
        })

        # req3 cleared, but req1 STILL active and session NOT falsely settled!
        ev3 = handle_events({}, session_id="sess-A")
        pending_ids3 = [p["id"] for p in ev3["pending_requests"]]
        self.assertNotIn(req3, pending_ids3)
        self.assertIn(req1, pending_ids3)
        self.assertTrue(ev3["turn_active"])
        self.assertFalse(ev3["session_settled"])

        # 4. Native get_state response updates state authoritatively
        req_state = handle_rpc({"command": "get_state"}, session_id="sess-A")["request_id"]
        client.emit_frame({
            "id": req_state,
            "type": "response",
            "command": "get_state",
            "success": True,
            "data": {"isSettled": False, "isStreaming": True},
        })
        ev4 = handle_events({}, session_id="sess-A")
        self.assertTrue(ev4["turn_active"])
        self.assertFalse(ev4["session_settled"])

        # 5. Finally prompt 1 completes with prompt_result
        client.emit_frame({
            "id": req1,
            "type": "prompt_result",
            "status": "completed",
            "sessionSettled": True,
        })
        ev5 = handle_events({}, session_id="sess-A")
        self.assertNotIn(req1, [p["id"] for p in ev5["pending_requests"]])
        self.assertTrue(ev5["session_settled"])
        self.assertFalse(ev5["turn_active"])

    # -----------------------------------------------------------------------
    # 7. omp_respond: Strict Native Validation, Options, Updates, and Safety
    # -----------------------------------------------------------------------
    def test_respond_stale_or_non_owned_rejected(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        res = handle_respond(
            {"response": {"type": "extension_ui_response", "id": "non-existent-id", "confirmed": True}},
            session_id="sess-A",
        )
        self.assertFalse(res["ok"])


    def test_respond_type_mismatch_rejected(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        client.emit_frame({"type": "extension_ui_request", "id": "ui-1", "method": "confirm"})

        # Sending host_tool_result for a UI request must fail type match
        res = handle_respond(
            {"response": {"type": "host_tool_result", "id": "ui-1", "result": {}}},
            session_id="sess-A",
        )
        self.assertFalse(res["ok"])


        # Request must remain pending
        ev = handle_events({}, session_id="sess-A")
        self.assertIn("ui-1", [p["id"] for p in ev["pending_requests"]])

    def test_respond_ui_confirm_strict_boolean(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        client.emit_frame({"type": "extension_ui_request", "id": "ui-confirm-1", "method": "confirm", "message": "Proceed?"})

        # String "true" must be rejected
        res_str = handle_respond(
            {"response": {"type": "extension_ui_response", "id": "ui-confirm-1", "confirmed": "true"}},
            session_id="sess-A",
        )
        self.assertFalse(res_str["ok"])


        # Request must NOT be consumed by invalid response
        ev = handle_events({}, session_id="sess-A")
        pending_ids = [p["id"] for p in ev["pending_requests"]]
        self.assertIn("ui-confirm-1", pending_ids)

        # Valid boolean confirm
        res_valid = handle_respond(
            {"response": {"type": "extension_ui_response", "id": "ui-confirm-1", "confirmed": True}},
            session_id="sess-A",
        )
        self.assertTrue(res_valid["ok"])
        self.assertEqual(res_valid["type"], "extension_ui_response")

        # Now consumed
        ev2 = handle_events({}, session_id="sess-A")
        pending_ids2 = [p["id"] for p in ev2["pending_requests"]]
        self.assertNotIn("ui-confirm-1", pending_ids2)

    def test_respond_ui_select_enforces_offered_options(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        client.emit_frame({
            "type": "extension_ui_request",
            "id": "ui-sel-1",
            "method": "select",
            "message": "Choose",
            "options": ["opt_a", "opt_b"],
        })

        res_bad = handle_respond(
            {"response": {"type": "extension_ui_response", "id": "ui-sel-1", "value": "opt_c"}},
            session_id="sess-A",
        )
        self.assertFalse(res_bad["ok"])


        res_good = handle_respond(
            {"response": {"type": "extension_ui_response", "id": "ui-sel-1", "value": "opt_a"}},
            session_id="sess-A",
        )
        self.assertTrue(res_good["ok"])

    def test_respond_ui_cancel_removes_target_id(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        client.emit_frame({
            "type": "extension_ui_request",
            "id": "ui-req-99",
            "method": "input",
            "message": "Name",
        })
        ev = handle_events({}, session_id="sess-A")
        self.assertIn("ui-req-99", [p["id"] for p in ev["pending_requests"]])

        # Inbound cancel notification from OMP
        client.emit_frame({
            "type": "extension_ui_request",
            "method": "cancel",
            "targetId": "ui-req-99",
        })

        ev2 = handle_events({}, session_id="sess-A")
        self.assertNotIn("ui-req-99", [p["id"] for p in ev2["pending_requests"]])

    def test_respond_host_tool_update_preserves_id_and_result_consumes(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        self.assertIsNotNone(client)

        client.emit_frame({
            "type": "host_tool_call",
            "id": "call-123",
            "toolName": "render_video",
            "toolCallId": "tc-1",
            "arguments": {"duration": 10},
        })

        # 1. Intermediate update
        res_upd = handle_respond(
            {
                "response": {
                    "type": "host_tool_update",
                    "id": "call-123",
                    "partialResult": {"progress": 50},
                }
            },
            session_id="sess-A",
        )
        self.assertTrue(res_upd["ok"])
        self.assertEqual(res_upd["type"], "host_tool_update")

        # Crucial: ID must still be pending after intermediate update!
        ev1 = handle_events({}, session_id="sess-A")
        pending_ids1 = [p["id"] for p in ev1["pending_requests"]]
        self.assertIn("call-123", pending_ids1)

        # 2. Terminal result
        res_term = handle_respond(
            {
                "response": {
                    "type": "host_tool_result",
                    "id": "call-123",
                    "result": {"output_file": "/tmp/video.mp4"},
                }
            },
            session_id="sess-A",
        )
        self.assertTrue(res_term["ok"])
        self.assertEqual(res_term["type"], "host_tool_result")

        # Now consumed from pending
        ev2 = handle_events({}, session_id="sess-A")
        pending_ids2 = [p["id"] for p in ev2["pending_requests"]]
        self.assertNotIn("call-123", pending_ids2)

    def test_host_uri_invalid_reply_remains_repairable(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        client.emit_frame({
            "type": "host_uri_request", "id": "uri-456",
            "operation": "read", "url": "smokefile://input",
        })
        response = {
            "type": "host_uri_result", "id": "uri-456", "content": "file content",
            "contentType": "text/plain", "notes": ["checksum-verified"], "immutable": True,
        }
        for invalid in ({"content": []}, {"notes": "not-an-array"}, {"isError": "false"}):
            result = handle_respond({"response": {**response, **invalid}}, session_id="sess-A")
            self.assertFalse(result["ok"])
            self.assertIn("uri-456", [item["id"] for item in handle_events({}, session_id="sess-A")["pending_requests"]])
        self.assertTrue(handle_respond({"response": response}, session_id="sess-A")["ok"])
        self.assertNotIn("uri-456", [item["id"] for item in handle_events({}, session_id="sess-A")["pending_requests"]])
        self.assertFalse(handle_respond({"response": response}, session_id="sess-A")["ok"])

    def test_failed_ui_write_does_not_consume_pending_request(self) -> None:
        handle_open({"mode": "new"}, session_id="sess-A")
        client = self.last_client
        client.emit_frame({"type": "extension_ui_request", "id": "confirm-1", "method": "confirm"})
        response = {"type": "extension_ui_response", "id": "confirm-1", "confirmed": False}
        client.fail_write = True
        self.assertFalse(handle_respond({"response": response}, session_id="sess-A")["ok"])
        self.assertIn("confirm-1", [item["id"] for item in handle_events({}, session_id="sess-A")["pending_requests"]])
        client.fail_write = False
        self.assertTrue(handle_respond({"response": response}, session_id="sess-A")["ok"])
        self.assertNotIn("confirm-1", [item["id"] for item in handle_events({}, session_id="sess-A")["pending_requests"]])


    # -----------------------------------------------------------------------
    # 8. omp_close & Multi-Conversation Lifecycle
    # -----------------------------------------------------------------------
    def test_close_and_reopen_lifecycle(self) -> None:
        res_open = handle_open({"mode": "new", "executor": "main"}, session_id="sess-A")
        self.assertTrue(res_open["ok"])

        # Close session
        res_close = handle_close({"executor": "main"}, session_id="sess-A")
        self.assertTrue(res_close["ok"])
        self.assertTrue(res_close["closed"])

        # Can now reopen with same logical name
        res_reopen = handle_open({"mode": "new", "executor": "main"}, session_id="sess-A")
        self.assertTrue(res_reopen["ok"])

    def test_cross_session_isolation_and_cleanup(self) -> None:
        handle_open({"mode": "new", "executor": "w1"}, session_id="sess-A")
        handle_open({"mode": "new", "executor": "w1"}, session_id="sess-B")

        # Disconnecting sess-A should not affect sess-B
        self.registry.close_hermes_session("sess-A")

        session_a = self.registry.get("sess-A", "w1")
        self.assertIsNone(session_a)

        session_b = self.registry.get("sess-B", "w1")
        self.assertIsNotNone(session_b)
        self.assertTrue(session_b.is_running())


if __name__ == "__main__":
    unittest.main()
