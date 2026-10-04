#!/usr/bin/env python3
"""Authenticated TCP OMP stdio transport server."""

from __future__ import annotations

import datetime
import fcntl
import hashlib
import hmac
import json
import logging
import os
import re
import select
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("direct_executor.server")

VALID_THINKING = frozenset(
    {"inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"}
)
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
CHUNK_SIZE = 65536


def write_all(fd: int, data: bytes) -> None:
    mv = memoryview(data)
    while mv:
        n = os.write(fd, mv)
        mv = mv[n:]


def load_token() -> str:
    token_file = os.environ.get("OMP_EXECUTOR_TOKEN_FILE", "/run/secrets/executor-token")
    token = None
    if os.path.isfile(token_file):
        try:
            with open(token_file, "r", encoding="utf-8") as f:
                token = f.read().strip()
        except OSError as e:
            raise RuntimeError(f"Cannot read token file '{token_file}': {e}")
    elif "OMP_EXECUTOR_TOKEN" in os.environ:
        token = os.environ["OMP_EXECUTOR_TOKEN"].strip()
    if not token:
        raise RuntimeError("Strict non-empty executor token required")
    return token

def parse_session_file(path: str, st: Optional[os.stat_result] = None) -> Optional[Dict[str, Any]]:
    try:
        if os.path.islink(path):
            return None
        if st is None:
            st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_size == 0:
            return None

        canonical_path = os.path.realpath(path)
        session_name: Optional[str] = None
        session_header: Optional[Dict[str, Any]] = None

        with open(canonical_path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    return None
                if not isinstance(entry, dict):
                    return None

                etype = entry.get("type")

                # Native set_session_name uses session_info.name; also check title/title_change
                if etype == "session_info":
                    n = entry.get("name")
                    if isinstance(n, str) and n.strip():
                        session_name = n.strip()
                    else:
                        sinfo = entry.get("session_info")
                        if isinstance(sinfo, dict):
                            n2 = sinfo.get("name")
                            if isinstance(n2, str) and n2.strip():
                                session_name = n2.strip()
                elif etype in ("title", "title_change"):
                    t = entry.get("title") or entry.get("name")
                    if isinstance(t, str) and t.strip():
                        session_name = t.strip()

                if etype == "session":
                    if session_header is not None:
                        # Only one session header permitted
                        return None
                    sid = entry.get("id")
                    cwd = entry.get("cwd")
                    if not sid or not isinstance(sid, str) or not cwd or not isinstance(cwd, str):
                        return None
                    if not os.path.isabs(cwd):
                        return None
                    session_header = entry
                    hn = entry.get("name") or entry.get("title")
                    if isinstance(hn, str) and hn.strip() and not session_name:
                        session_name = hn.strip()
                elif session_header is None:
                    # Require header before non-title / non-metadata entries
                    if etype not in ("title", "session_info"):
                        return None

        if session_header is None:
            return None

        sid = str(session_header["id"])
        cwd = str(session_header["cwd"])
        mtime_dt = datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc)
        modified_at = mtime_dt.isoformat().replace("+00:00", "Z")

        res: Dict[str, Any] = {
            "session_id": sid,
            "session_file": canonical_path,
            "cwd": cwd,
            "modified_at": modified_at,
        }
        if session_name:
            res["name"] = session_name
        parent = session_header.get("parentSession")
        if isinstance(parent, str) and parent.strip():
            res["parent_session"] = parent.strip()

        return res
    except Exception:
        return None


def scan_sessions_tree(root: str) -> List[Dict[str, Any]]:
    real_root = os.path.realpath(root)
    if not os.path.isdir(real_root) or os.path.islink(root):
        return []
    results: List[Dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(real_root, followlinks=False):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
        for name in filenames:
            if not name.endswith(".jsonl"):
                continue
            fpath = os.path.join(dirpath, name)
            if os.path.islink(fpath):
                continue
            try:
                st = os.lstat(fpath)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_size == 0:
                continue
            entry = parse_session_file(fpath, st)
            if entry is not None:
                results.append(entry)
    return results
def prepare_workspace(root: str, executor: str) -> Tuple[str, str]:
    real_root = os.path.realpath(root)
    os.makedirs(real_root, mode=0o700, exist_ok=True)
    workdir = os.path.join(real_root, executor)
    if os.path.islink(workdir):
        raise ValueError("Workspace is a symlink")
    if os.path.exists(workdir):
        if not os.path.isdir(workdir):
            raise ValueError("Workspace is not a directory")
        real_workdir = os.path.realpath(workdir)
        if os.path.commonpath([real_root, real_workdir]) != real_root or real_workdir == real_root:
            raise ValueError("Workspace path escapes root")
    else:
        os.makedirs(workdir, mode=0o700, exist_ok=True)
    sessions = os.path.join(workdir, "sessions")
    if os.path.islink(sessions):
        raise ValueError("Sessions dir is a symlink")
    os.makedirs(sessions, mode=0o700, exist_ok=True)
    return workdir, sessions


def kill_process_group_bounded(pgid: int, proc: subprocess.Popen, timeout: float = 3.0) -> None:
    def alive() -> bool:
        proc.poll()
        try:
            os.killpg(pgid, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    if not alive():
        proc.poll()
        return

    try:
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        pass

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not alive():
            proc.poll()
            return
        time.sleep(0.05)

    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass

    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if not alive():
            break
        time.sleep(0.05)
    proc.poll()


def read_handshake(sock: socket.socket, limit: int = 65536, timeout: float = 10.0) -> Tuple[bytes, bytes]:
    deadline = time.monotonic() + timeout
    buf = bytearray()
    while True:
        rem = deadline - time.monotonic()
        if rem <= 0:
            raise TimeoutError("Handshake timed out")
        sock.settimeout(rem)
        try:
            chunk = sock.recv(min(4096, limit - len(buf)))
        except (socket.timeout, TimeoutError):
            raise TimeoutError("Handshake timed out")
        if not chunk:
            break
        buf.extend(chunk)
        nl = buf.find(b"\n")
        if nl != -1:
            return bytes(buf[: nl + 1]), bytes(buf[nl + 1 :])
        if len(buf) >= limit:
            raise ValueError("Handshake exceeded maximum size")
    return bytes(buf), b""


def send_error(sock: socket.socket, msg: str) -> None:
    try:
        sock.sendall((json.dumps({"type": "transport_error", "error": msg}) + "\n").encode("utf-8"))
    except OSError:
        pass


class DirectExecutorServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: Tuple[str, int],
        token: str,
        executor_root: str = "/data/executor/workspaces",
        omp_bin: str = "omp",
        default_model: Optional[str] = None,
        default_thinking: Optional[str] = None,
        operator_config: Optional[str] = None,
        handshake_timeout: float = 10.0,
        startup_timeout: float = 15.0,
        cleanup_timeout: float = 3.0,
        sessions_root: Optional[str] = None,
    ):
        super().__init__(server_address, DirectExecutorHandler)
        self.token = token
        self.executor_root = executor_root
        self.omp_bin = omp_bin
        self.default_model = default_model
        self.default_thinking = default_thinking
        self.operator_config = operator_config
        self.handshake_timeout = handshake_timeout
        self.startup_timeout = startup_timeout
        self.cleanup_timeout = cleanup_timeout
        self.sessions_root = sessions_root or os.environ.get(
            "OMP_SESSIONS_DIR", os.path.expanduser("~/.omp/agent/sessions")
        )
        self.active_executors: Dict[str, str] = {}
        self.active_cwds: Set[str] = set()
        self.active_procs: Dict[int, Tuple[int, subprocess.Popen]] = {}
        self.lock = threading.Lock()

    def acquire(self, ex: str, real_cwd: str) -> bool:
        with self.lock:
            if ex in self.active_executors or real_cwd in self.active_cwds:
                return False
            self.active_executors[ex] = real_cwd
            self.active_cwds.add(real_cwd)
            return True

    def release(self, ex: str, real_cwd: str) -> None:
        with self.lock:
            self.active_executors.pop(ex, None)
            self.active_cwds.discard(real_cwd)

    def get_catalog(self) -> List[Dict[str, Any]]:
        seen_files: Set[str] = set()
        all_sessions: List[Dict[str, Any]] = []
        roots = [self.executor_root]
        if self.sessions_root and self.sessions_root not in roots:
            roots.append(self.sessions_root)

        for root in roots:
            for sess in scan_sessions_tree(root):
                sfile = sess["session_file"]
                if sfile not in seen_files:
                    seen_files.add(sfile)
                    all_sessions.append(sess)

        all_sessions.sort(key=lambda s: s["session_file"])
        all_sessions.sort(key=lambda s: s["modified_at"], reverse=True)
        return all_sessions

    def register(self, pgid: int, proc: subprocess.Popen) -> None:
        with self.lock:
            self.active_procs[proc.pid] = (pgid, proc)

    def unregister(self, pid: int) -> None:
        with self.lock:
            self.active_procs.pop(pid, None)

    def shutdown_all_processes(self) -> None:
        with self.lock:
            procs = list(self.active_procs.values())
        for pgid, proc in procs:
            kill_process_group_bounded(pgid, proc, timeout=1.0)

class DirectExecutorHandler(socketserver.BaseRequestHandler):
    server: DirectExecutorServer

    def handle(self) -> None:
        sock = self.request
        srv = self.server

        try:
            line, leftover = read_handshake(sock, timeout=srv.handshake_timeout)
        except (TimeoutError, ValueError, OSError) as e:
            send_error(sock, f"Handshake failed: {e}")
            return
        if not line or not line.strip():
            return

        try:
            hs = json.loads(line.decode("utf-8"))
        except Exception:
            send_error(sock, "Malformed handshake JSON")
            return
        req_type = hs.get("type")
        if req_type not in ("connect", "sessions"):
            send_error(sock, "Handshake must be type 'connect' or 'sessions'")
            return

        tok = hs.get("token")
        if not isinstance(tok, str) or not hmac.compare_digest(tok.encode(), srv.token.encode()):
            send_error(sock, "Authentication failed")
            return

        if req_type == "sessions":
            offset = hs.get("offset", 0)
            if not isinstance(offset, int) or offset < 0:
                send_error(sock, "Invalid offset (must be non-negative integer)")
                return

            limit = hs.get("limit", 50)
            if not isinstance(limit, int) or limit < 1 or limit > 100:
                send_error(sock, "Invalid limit (must be integer between 1 and 100)")
                return

            catalog = srv.get_catalog()
            total = len(catalog)
            paged = catalog[offset : offset + limit]
            resp = {
                "type": "sessions",
                "sessions": paged,
                "total": total,
                "offset": offset,
                "limit": limit,
            }
            try:
                sock.sendall((json.dumps(resp) + "\n").encode("utf-8"))
            except OSError:
                pass
            return

        # Handle 'connect'
        ex = hs.get("executor")
        if not isinstance(ex, str) or not HEX64_RE.fullmatch(ex):
            send_error(sock, "Invalid executor ID (must be 64 lowercase hex)")
            return

        mode = hs.get("mode")
        if mode not in ("new", "resume"):
            send_error(sock, "Mode is mandatory and must be 'new' or 'resume'")
            return

        raw_model = hs.get("model")
        if raw_model is not None:
            if not isinstance(raw_model, str) or not raw_model.strip():
                send_error(sock, "model must be a non-empty string")
                return
            req_model: Optional[str] = raw_model.strip()
        else:
            req_model = None

        raw_thinking = hs.get("thinking")
        if raw_thinking is not None:
            if not isinstance(raw_thinking, str) or raw_thinking not in VALID_THINKING:
                send_error(sock, "Invalid thinking level")
                return
            req_thinking: Optional[str] = raw_thinking
        else:
            req_thinking = None

        cfg = srv.operator_config or os.environ.get("OMP_EXECUTOR_CONFIG")
        if cfg:
            if not os.path.isfile(cfg):
                send_error(sock, f"Operator config file '{cfg}' not found or not a regular file")
                return

        resume_session_file: Optional[str] = None
        resumed = False

        if mode == "new":
            if hs.get("session_id") is not None or hs.get("session_file") is not None:
                send_error(sock, "Resume selectors (session_id, session_file) not allowed in 'new' mode")
                return

            custom_cwd = hs.get("cwd")
            if custom_cwd is not None:
                if not isinstance(custom_cwd, str) or not custom_cwd.strip():
                    send_error(sock, "cwd must be a non-empty string")
                    return
                custom_cwd = custom_cwd.strip()
                if not os.path.isabs(custom_cwd):
                    send_error(sock, "cwd must be an absolute path")
                    return
                if os.path.islink(custom_cwd):
                    send_error(sock, "cwd cannot be a symlink")
                    return
                if not os.path.isdir(custom_cwd):
                    send_error(sock, f"cwd '{custom_cwd}' does not exist or is not a directory")
                    return

            try:
                managed_workdir, sessions = prepare_workspace(srv.executor_root, ex)
            except ValueError as e:
                send_error(sock, f"Workspace security rejected: {e}")
                return

            if custom_cwd:
                real_workdir = os.path.realpath(custom_cwd)
            else:
                real_workdir = os.path.realpath(managed_workdir)
            session_dir = sessions

            if req_model:
                model = req_model
            else:
                def_model = srv.default_model or os.environ.get("OMP_EXECUTOR_MODEL")
                model = def_model.strip() if def_model and def_model.strip() else None

            if req_thinking:
                thinking = req_thinking
            else:
                def_thinking = srv.default_thinking or os.environ.get("OMP_EXECUTOR_THINKING")
                thinking = def_thinking if def_thinking and def_thinking in VALID_THINKING else None
        else:
            if hs.get("cwd") is not None:
                send_error(sock, "cwd parameter not allowed in 'resume' mode")
                return

            req_sid = hs.get("session_id")
            req_sfile = hs.get("session_file")
            if not req_sid and not req_sfile:
                send_error(sock, "Resume mode requires session_id or session_file selector")
                return
            if req_sid is not None and (not isinstance(req_sid, str) or not req_sid.strip()):
                send_error(sock, "Invalid session_id selector")
                return
            if req_sfile is not None:
                if not isinstance(req_sfile, str) or not req_sfile.strip():
                    send_error(sock, "Invalid session_file selector")
                    return
                req_sfile = req_sfile.strip()
                if not os.path.isabs(req_sfile):
                    send_error(sock, "session_file must be an absolute path")
                    return
                if os.path.islink(req_sfile):
                    send_error(sock, "session_file cannot be a symlink")
                    return

            catalog = srv.get_catalog()
            matches = catalog
            if req_sfile:
                # Match exact catalog path only; no silent canonicalization of symlink aliases
                matches = [s for s in matches if s["session_file"] == req_sfile]
                if not matches:
                    send_error(sock, f"Session file '{req_sfile}' not found in catalog")
                    return
            if req_sid:
                matches = [s for s in matches if s["session_id"] == req_sid]
                if not matches:
                    send_error(sock, f"Session ID '{req_sid}' not found in catalog")
                    return
                if len(matches) > 1:
                    send_error(sock, f"Ambiguous session ID '{req_sid}': matched multiple catalog sessions")
                    return

            if len(matches) != 1:
                send_error(sock, "Session selector did not resolve to a unique session")
                return

            selected = matches[0]
            resume_session_file = selected["session_file"]
            verified = parse_session_file(resume_session_file)
            if verified is None:
                send_error(sock, "Selected session history is corrupted or invalid")
                return

            workdir_from_header = verified["cwd"]
            if os.path.islink(workdir_from_header):
                send_error(sock, "Session working directory is a symlink")
                return
            real_workdir = os.path.realpath(workdir_from_header)
            if not os.path.isdir(real_workdir):
                send_error(sock, f"Session working directory '{workdir_from_header}' does not exist")
                return

            session_dir = os.path.dirname(resume_session_file)
            if os.path.islink(session_dir):
                send_error(sock, "Session directory is a symlink")
                return
            if not os.path.isdir(session_dir):
                send_error(sock, f"Session directory '{session_dir}' does not exist")
                return
            resumed = True

            # Resume mode forwards ONLY explicitly requested model/thinking
            model = req_model
            thinking = req_thinking

        if not srv.acquire(ex, real_workdir):
            send_error(sock, f"Workspace '{real_workdir}' is locked by active session")
            return

        runtime_dir = os.path.join(os.path.realpath(srv.executor_root), ".runtime")
        try:
            if os.path.islink(runtime_dir):
                raise ValueError("Runtime directory is a symlink")
            os.makedirs(runtime_dir, mode=0o700, exist_ok=True)
        except (OSError, ValueError) as e:
            srv.release(ex, real_workdir)
            send_error(sock, f"Runtime directory rejected: {e}")
            return
        cwd_key = hashlib.sha256(real_workdir.encode()).hexdigest()
        lock_path = os.path.join(runtime_dir, cwd_key + ".lock")

        lock_fd: Optional[int] = None
        try:
            lock_flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
            lock_fd = os.open(lock_path, lock_flags, 0o600)
            st = os.fstat(lock_fd)
            if not stat.S_ISREG(st.st_mode):
                raise ValueError("Lock path is not a regular file")
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception as e:
            if lock_fd is not None:
                try:
                    os.close(lock_fd)
                except OSError:
                    pass
            srv.release(ex, real_workdir)
            send_error(sock, f"Workspace lock failure: {e}")
            return

        cmd = [srv.omp_bin, "--mode", "rpc-ui", "--cwd", real_workdir, "--session-dir", session_dir]
        if model:
            cmd.extend(["--model", model])
        if thinking:
            cmd.extend(["--thinking", thinking])
        if cfg:
            cmd.extend(["--config", cfg])
        if resumed and resume_session_file:
            cmd.extend(["--resume", resume_session_file])
        stderr_path = os.path.join(runtime_dir, cwd_key + ".stderr.log")
        try:
            err_file = open(stderr_path, "a", encoding="utf-8")
        except OSError as e:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                os.close(lock_fd)
            except OSError:
                pass
            srv.release(ex, real_workdir)
            send_error(sock, f"Failed to open stderr log: {e}")
            return
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=real_workdir,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=err_file,
                start_new_session=True,
            )
        except OSError as e:
            err_file.close()
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                os.close(lock_fd)
            except OSError:
                pass
            srv.release(ex, real_workdir)
            send_error(sock, f"Failed to spawn executor: {e}")
            return

        pgid = proc.pid
        srv.register(pgid, proc)

        try:
            r, _, _ = select.select([proc.stdout], [], [], srv.startup_timeout)
            if not r or (proc.poll() is not None and proc.poll() != 0):
                kill_process_group_bounded(pgid, proc, timeout=srv.cleanup_timeout)
                err_file.close()
                send_error(sock, f"Executor startup failed (code {proc.poll()}). Details in {stderr_path}")
                return

            first = os.read(proc.stdout.fileno(), CHUNK_SIZE)
            if not first:
                proc.wait()
                err_file.close()
                send_error(sock, f"Executor closed stdout during startup. Details in {stderr_path}")
                return

            sock.sendall((json.dumps({"type": "connected", "executor": ex, "workdir": real_workdir, "resumed": resumed, "session_file": resume_session_file}) + "\n").encode())
            sock.sendall(first)
            sock.settimeout(None)

            if leftover and proc.stdin and not proc.stdin.closed:
                try:
                    write_all(proc.stdin.fileno(), leftover)
                except OSError:
                    pass

            relay_done = threading.Event()

            def relay_out():
                try:
                    out_fd = proc.stdout.fileno()
                    while True:
                        c = os.read(out_fd, CHUNK_SIZE)
                        if not c:
                            break
                        sock.sendall(c)
                except (OSError, BrokenPipeError):
                    pass
                finally:
                    try:
                        sock.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    # Unblock inbound recv if client still keeping input open
                    try:
                        sock.shutdown(socket.SHUT_RD)
                    except OSError:
                        pass
                    relay_done.set()

            def relay_in():
                try:
                    in_fd = proc.stdin.fileno()
                    while True:
                        c = sock.recv(CHUNK_SIZE)
                        if not c:
                            break
                        write_all(in_fd, c)
                except (OSError, BrokenPipeError):
                    pass
                finally:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass

            to = threading.Thread(target=relay_out, daemon=True)
            ti = threading.Thread(target=relay_in, daemon=True)
            to.start()
            ti.start()

            # Wait for relay to complete from either direction
            while not relay_done.is_set():
                if proc.poll() is not None:
                    # Child exited: wait up to 1.0s for remaining output to flush
                    if relay_done.wait(timeout=1.0):
                        break
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    break
                if relay_done.wait(timeout=0.05):
                    break

            if to.is_alive() or proc.poll() is None:
                kill_process_group_bounded(pgid, proc, timeout=srv.cleanup_timeout)

            to.join(timeout=1.0)
            ti.join(timeout=1.0)
        finally:
            srv.unregister(proc.pid)
            kill_process_group_bounded(pgid, proc, timeout=srv.cleanup_timeout)
            if proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
            if proc.stdout and not proc.stdout.closed:
                try:
                    proc.stdout.close()
                except OSError:
                    pass
            proc.poll()
            try:
                proc.wait(timeout=0.1)
            except Exception:
                pass
            try:
                err_file.close()
            except Exception:
                pass
            if lock_fd is not None:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                except Exception:
                    pass
                try:
                    os.close(lock_fd)
                except OSError:
                    pass
            srv.release(ex, real_workdir)


def main() -> None:
    host = os.environ.get("OMP_EXECUTOR_HOST", "0.0.0.0")
    port = int(os.environ.get("OMP_EXECUTOR_PORT", "9876"))
    root = os.environ.get("OMP_EXECUTOR_ROOT", "/data/executor/workspaces")
    bin_path = os.environ.get("OMP_EXECUTOR_BIN", "omp")
    token = load_token()

    sessions_root = os.environ.get(
        "OMP_SESSIONS_DIR", os.path.expanduser("~/.omp/agent/sessions")
    )

    server = DirectExecutorServer(
        server_address=(host, port),
        token=token,
        executor_root=root,
        omp_bin=bin_path,
        default_model=os.environ.get("OMP_EXECUTOR_MODEL"),
        default_thinking=os.environ.get("OMP_EXECUTOR_THINKING"),
        operator_config=os.environ.get("OMP_EXECUTOR_CONFIG"),
        sessions_root=sessions_root,
    )

    shutdown_event = threading.Event()

    def on_sig(_s: int, _f: object) -> None:
        shutdown_event.set()

    signal.signal(signal.SIGTERM, on_sig)
    signal.signal(signal.SIGINT, on_sig)

    srv_thread = threading.Thread(target=server.serve_forever, daemon=True)
    srv_thread.start()
    logger.info(f"Direct executor server listening on {host}:{port}")

    while not shutdown_event.is_set():
        shutdown_event.wait(timeout=0.5)

    logger.info("Direct executor server shutting down...")
    server.shutdown_all_processes()
    server.shutdown()
    server.server_close()
    srv_thread.join(timeout=3.0)


if __name__ == "__main__":
    main()
