#!/usr/bin/env python3
"""Process-backed stdio tunnel to authenticated TCP direct executor."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import sys
import threading
import time
from typing import Tuple

HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
CHUNK_SIZE = 65536


def write_all(fd: int, data: bytes) -> None:
    mv = memoryview(data)
    while mv:
        n = os.write(fd, mv)
        mv = mv[n:]


def load_token() -> str:
    token = os.environ.get("OMP_EXECUTOR_TOKEN")
    if token and token.strip():
        return token.strip()
    token_file = os.environ.get("OMP_EXECUTOR_TOKEN_FILE", "/run/secrets/executor-token")
    if os.path.isfile(token_file):
        try:
            with open(token_file, "r", encoding="utf-8") as f:
                c = f.read().strip()
                if c:
                    return c
        except OSError as e:
            sys.stderr.write(f"Failed to read token file: {e}\n")
            sys.exit(1)
    sys.stderr.write("Executor token required in OMP_EXECUTOR_TOKEN or OMP_EXECUTOR_TOKEN_FILE\n")
    sys.exit(1)


def read_handshake_line(sock: socket.socket, limit: int = 65536, timeout: float = 15.0) -> Tuple[bytes, bytes]:
    deadline = time.monotonic() + timeout
    buf = bytearray()
    while True:
        rem = deadline - time.monotonic()
        if rem <= 0:
            raise TimeoutError("Handshake response timed out")
        sock.settimeout(rem)
        try:
            chunk = sock.recv(min(4096, limit - len(buf)))
        except (socket.timeout, TimeoutError):
            raise TimeoutError("Handshake response timed out")
        if not chunk:
            break
        buf.extend(chunk)
        nl = buf.find(b"\n")
        if nl != -1:
            return bytes(buf[: nl + 1]), bytes(buf[nl + 1 :])
        if len(buf) >= limit:
            raise ValueError("Handshake response exceeded limit")
    return bytes(buf), b""


def main() -> int:
    parser = argparse.ArgumentParser(description="Stdio tunnel to direct executor")
    parser.add_argument("--list-sessions", action="store_true", help="List sessions catalog")
    parser.add_argument("--offset", type=int, default=0, help="Catalog offset")
    parser.add_argument("--limit", type=int, default=50, help="Catalog limit (1..100)")
    parser.add_argument("--cwd", default=None, help="Working directory for new session (absolute path)")
    parser.add_argument("--executor", default=None, help="64 hex executor ID")
    parser.add_argument("--mode", default=None, choices=["new", "resume"], help="Session mode ('new' or 'resume')")
    parser.add_argument("--session-id", default=None, help="Session ID to resume")
    parser.add_argument("--session-file", default=None, help="Session file to resume")
    parser.add_argument("--model", default=None, help="Target model")
    parser.add_argument("--thinking", default=None, help="Thinking level")
    args = parser.parse_args()

    token = load_token()
    host = os.environ.get("OMP_EXECUTOR_HOST", "127.0.0.1")
    port = int(os.environ.get("OMP_EXECUTOR_PORT", "9876"))
    timeout = float(os.environ.get("OMP_EXECUTOR_TIMEOUT", "15.0"))

    if args.list_sessions:
        if args.offset < 0:
            sys.stderr.write("Invalid --offset (must be >= 0)\n")
            return 1
        if args.limit < 1 or args.limit > 100:
            sys.stderr.write("Invalid --limit (must be 1..100)\n")
            return 1

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect((host, port))
        except (OSError, socket.timeout) as e:
            sys.stderr.write(f"Connect failed to {host}:{port}: {e}\n")
            return 1

        req = {"type": "sessions", "token": token, "offset": args.offset, "limit": args.limit}
        try:
            sock.sendall((json.dumps(req) + "\n").encode())
            line, _ = read_handshake_line(sock, limit=4 * 1024 * 1024, timeout=timeout)
        except (OSError, TimeoutError, ValueError) as e:
            sys.stderr.write(f"Catalog handshake error: {e}\n")
            sock.close()
            return 1

        if not line:
            sys.stderr.write("Connection closed during catalog handshake\n")
            sock.close()
            return 1

        try:
            resp = json.loads(line.decode("utf-8"))
        except Exception as e:
            sys.stderr.write(f"Malformed catalog JSON: {e}\n")
            sock.close()
            return 1

        if resp.get("type") == "transport_error":
            sys.stderr.write(f"Transport error: {resp.get('error')}\n")
            sock.close()
            return 1
        if resp.get("type") != "sessions":
            sys.stderr.write(f"Unexpected response frame: {resp}\n")
            sock.close()
            return 1

        out_bytes = line if line.endswith(b"\n") else line + b"\n"
        write_all(sys.stdout.fileno(), out_bytes)
        try:
            sock.close()
        except OSError:
            pass
        return 0

    if not args.executor or not HEX64_RE.fullmatch(args.executor):
        sys.stderr.write("Invalid or missing --executor (must be 64 lowercase hex)\n")
        return 1
    if not args.mode or args.mode not in ("new", "resume"):
        sys.stderr.write("Invalid or missing --mode (must be 'new' or 'resume')\n")
        return 1
    if args.mode == "new" and (args.session_id or args.session_file):
        sys.stderr.write("Resume selectors (--session-id, --session-file) not allowed in 'new' mode\n")
        return 1
    if args.mode == "resume" and not (args.session_id or args.session_file):
        sys.stderr.write("Resume mode requires --session-id or --session-file\n")
        return 1

    if args.cwd:
        if not os.path.isabs(args.cwd):
            sys.stderr.write("cwd must be an absolute path\n")
            return 1

    if args.mode == "resume" and args.cwd:
        sys.stderr.write("--cwd is not allowed in 'resume' mode\n")
        return 1

    if args.mode == "resume" and args.session_file:
        if not os.path.isabs(args.session_file):
            sys.stderr.write("--session-file must be an absolute path\n")
            return 1

    if args.model is not None and not args.model.strip():
        sys.stderr.write("model must be a non-empty string\n")
        return 1
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)

    def on_sig(_s: int, _f: object) -> None:
        try:
            sock.close()
        except OSError:
            pass
        sys.exit(143)

    signal.signal(signal.SIGTERM, on_sig)
    signal.signal(signal.SIGINT, on_sig)

    try:
        sock.connect((host, port))
    except (OSError, socket.timeout) as e:
        sys.stderr.write(f"Connect failed to {host}:{port}: {e}\n")
        return 1

    req = {
        "type": "connect",
        "token": token,
        "executor": args.executor,
        "mode": args.mode,
    }
    if args.cwd:
        req["cwd"] = args.cwd
    if args.session_id:
        req["session_id"] = args.session_id
    if args.session_file:
        req["session_file"] = args.session_file
    if args.model:
        req["model"] = args.model.strip()
    if args.thinking:
        req["thinking"] = args.thinking
    try:
        sock.sendall((json.dumps(req) + "\n").encode())
        line, leftover = read_handshake_line(sock, timeout=timeout)
    except (OSError, TimeoutError, ValueError) as e:
        sys.stderr.write(f"Handshake error: {e}\n")
        sock.close()
        return 1

    if not line:
        sys.stderr.write("Connection closed during handshake\n")
        sock.close()
        return 1

    try:
        resp = json.loads(line.decode("utf-8"))
    except Exception as e:
        sys.stderr.write(f"Malformed handshake JSON: {e}\n")
        sock.close()
        return 1

    if resp.get("type") == "transport_error":
        sys.stderr.write(f"Transport error: {resp.get('error')}\n")
        sock.close()
        return 1
    if resp.get("type") != "connected":
        sys.stderr.write(f"Unexpected response frame: {resp}\n")
        sock.close()
        return 1
    selected_file = resp.get("session_file")
    expected_resume = args.mode == "resume"
    if ("session_file" not in resp or resp.get("executor") != args.executor
            or resp.get("resumed") is not expected_resume
            or (not expected_resume and selected_file is not None)
            or (expected_resume and (not isinstance(selected_file, str) or not os.path.isabs(selected_file)))
            or (args.session_file is not None and selected_file != args.session_file)):
        sys.stderr.write("Worker acknowledgement does not match the explicit session selection; rebuild both direct-executor images\n")
        sock.close()
        return 1

    sock.settimeout(None)

    out_fd = sys.stdout.fileno()

    # Forward any coalesced bytes received along with connected frame
    if leftover:
        try:
            write_all(out_fd, leftover)
        except OSError:
            pass

    stdin_eof = False
    remote_eof = False
    lock = threading.Lock()

    def relay_stdin() -> None:
        nonlocal stdin_eof
        in_fd = sys.stdin.fileno()
        try:
            while True:
                chunk = os.read(in_fd, CHUNK_SIZE)
                if not chunk:
                    with lock:
                        stdin_eof = True
                    try:
                        sock.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    break
                sock.sendall(chunk)
        except (OSError, BrokenPipeError):
            pass

    def relay_stdout() -> None:
        nonlocal remote_eof
        try:
            while True:
                chunk = sock.recv(CHUNK_SIZE)
                if not chunk:
                    with lock:
                        remote_eof = True
                    break
                write_all(out_fd, chunk)
        except (OSError, BrokenPipeError):
            pass

    ti = threading.Thread(target=relay_stdin, daemon=True)
    to = threading.Thread(target=relay_stdout, daemon=True)
    ti.start()
    to.start()

    to.join()

    with lock:
        was_stdin_eof = stdin_eof
        was_remote_eof = remote_eof

    try:
        sock.close()
    except OSError:
        pass

    if was_remote_eof and not was_stdin_eof:
        sys.stderr.write("Remote transport closed before stdin EOF\n")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
