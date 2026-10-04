#!/usr/bin/env python3
"""Behavioral tests for direct executor TCP transport and subprocess tunnel."""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

DEPLOY_DIR = Path(__file__).resolve().parents[2] / "deploy" / "direct-executor"
if str(DEPLOY_DIR) not in sys.path:
    sys.path.insert(0, str(DEPLOY_DIR))

from server import (
    DirectExecutorServer,
    kill_process_group_bounded,
    parse_session_file,
    prepare_workspace,
    scan_sessions_tree,
)

FAKE_OMP = """
import sys, os, json, time

mode = os.environ.get("FAKE_OMP_MODE", "normal")

if mode == "immediate_exit":
    sys.exit(42)

if mode == "spawn_children":
    pid = os.fork()
    if pid == 0:
        while True:
            time.sleep(1)
        sys.exit(0)

# Output ready frame
sys.stdout.write(json.dumps({"type": "ready", "protocolVersion": 1}) + "\\n")
sys.stdout.flush()

if mode == "ready_then_crash":
    time.sleep(0.05)
    sys.exit(137)

while True:
    line = sys.stdin.readline()
    if not line:
        break
    try:
        cmd = json.loads(line)
        t = cmd.get("type")
        if t == "test_agent_end":
            sys.stdout.write(json.dumps({"type": "agent_end", "id": cmd.get("id")}) + "\\n")
            sys.stdout.flush()
        elif t == "test_chunk":
            sys.stdout.write(json.dumps({"type": "rpc_chunk", "chunkId": "c1", "data": "abc"}) + "\\n")
            sys.stdout.flush()
        else:
            sys.stdout.write(json.dumps({"id": cmd.get("id"), "type": "response", "success": True}) + "\\n")
            sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(json.dumps({"type": "error", "error": str(e)}) + "\\n")
        sys.stdout.flush()
"""

class DirectExecutorTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.test_dir = tempfile.mkdtemp(prefix="trans_test_")
        self.root_dir = os.path.join(self.test_dir, "workspaces")
        os.makedirs(self.root_dir, exist_ok=True)
        self.native_sessions_dir = os.path.join(self.test_dir, "native_sessions")
        os.makedirs(self.native_sessions_dir, exist_ok=True)

        self.fake_omp_path = os.path.join(self.test_dir, "fake_omp.py")
        with open(self.fake_omp_path, "w", encoding="utf-8") as f:
            f.write(FAKE_OMP)
        os.chmod(self.fake_omp_path, 0o755)

        self.token = "token-secret-xyz"
        self.server = DirectExecutorServer(
            server_address=("127.0.0.1", 0),
            token=self.token,
            executor_root=self.root_dir,
            omp_bin=sys.executable,
            default_model="test-model",
            handshake_timeout=2.0,
            startup_timeout=5.0,
            cleanup_timeout=1.0,
            sessions_root=self.native_sessions_dir,
        )

        self.omp_wrapper = os.path.join(self.test_dir, "omp_wrapper.sh")
        with open(self.omp_wrapper, "w", encoding="utf-8") as f:
            f.write(f"#!/bin/sh\nexec {sys.executable} {self.fake_omp_path} \"$@\"\n")
        os.chmod(self.omp_wrapper, 0o755)
        self.server.omp_bin = self.omp_wrapper

        self.server_port = self.server.server_address[1]
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
    def tearDown(self) -> None:
        self.server.shutdown_all_processes()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2.0)
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _open_client(self) -> tuple[socket.socket, any]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3.0)
        sock.connect(("127.0.0.1", self.server_port))
        reader = sock.makefile("r", encoding="utf-8")
        return sock, reader

    def _read_frame(self, reader) -> dict:
        line = reader.readline()
        if not line:
            raise EOFError("Socket closed")
        return json.loads(line)

    def test_auth_rejection(self) -> None:
        # 1. Connect with bad token
        sock, reader = self._open_client()
        sock.sendall((json.dumps({"type": "connect", "token": "bad", "executor": "0" * 64, "mode": "new"}) + "\n").encode())
        resp = self._read_frame(reader)
        self.assertEqual(resp.get("type"), "transport_error")
        reader.close()
        sock.close()

        # 2. Catalog with bad token -> no catalog leaked prior to auth!
        sock, reader = self._open_client()
        sock.sendall((json.dumps({"type": "sessions", "token": "bad"}) + "\n").encode())
        resp = self._read_frame(reader)
        self.assertEqual(resp.get("type"), "transport_error")
        reader.close()
        sock.close()

        # 3. Malformed JSON
        sock, reader = self._open_client()
        sock.sendall(b"not-json\n")
        resp = self._read_frame(reader)
        self.assertEqual(resp.get("type"), "transport_error")
        reader.close()
        sock.close()

        # 4. Bad executor ID
        sock, reader = self._open_client()
        sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": "bad-id", "mode": "new"}) + "\n").encode())
        resp = self._read_frame(reader)
        self.assertEqual(resp.get("type"), "transport_error")
        reader.close()
        sock.close()

        # 5. Missing mandatory mode
        sock, reader = self._open_client()
        sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": "0" * 64}) + "\n").encode())
        resp = self._read_frame(reader)
        self.assertEqual(resp.get("type"), "transport_error")
        reader.close()
        sock.close()

    def test_spawn_failure_releases_workspace_for_explicit_retry(self) -> None:
        request = {"type": "connect", "token": self.token, "executor": "9" * 64, "mode": "new"}
        self.server.omp_bin = os.path.join(self.test_dir, "missing-executable")
        sock, reader = self._open_client()
        try:
            sock.sendall((json.dumps(request) + "\n").encode())
            self.assertEqual(self._read_frame(reader)["type"], "transport_error")
        finally:
            reader.close()
            sock.close()

        self.server.omp_bin = self.omp_wrapper
        sock, reader = self._open_client()
        try:
            sock.sendall((json.dumps(request) + "\n").encode())
            self.assertEqual(self._read_frame(reader)["type"], "connected")
        finally:
            reader.close()
            sock.close()

    def test_healthcheck_probe(self) -> None:
        sock, reader = self._open_client()
        reader.close()
        sock.close()
        time.sleep(0.05)

        sock2, reader2 = self._open_client()
        sock2.sendall((json.dumps({"type": "connect", "token": self.token, "executor": "a" * 64, "mode": "new"}) + "\n").encode())
        resp = self._read_frame(reader2)
        self.assertEqual(resp.get("type"), "connected")
        reader2.close()
        sock2.close()

    def test_exclusive_cwd_locking_cross_digest(self) -> None:
        ex1 = "b" * 64
        ex2 = "1" * 64
        shared_cwd = os.path.join(self.test_dir, "shared_project")
        os.makedirs(shared_cwd, exist_ok=True)

        session_p = os.path.join(self.native_sessions_dir, "shared_session.jsonl")
        with open(session_p, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "session", "id": "shared-1", "cwd": shared_cwd}) + "\n")

        # Connection 1 resumes shared_session
        sock1, r1 = self._open_client()
        sock1.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex1,
            "mode": "resume",
            "session_id": "shared-1",
        }) + "\n").encode())
        resp1 = self._read_frame(r1)
        self.assertEqual(resp1.get("type"), "connected")
        self.assertEqual(resp1.get("resumed"), True)

        # Connection 2 (DIFFERENT executor ID) attempts to resume same shared_session (same real cwd) -> MUST FAIL
        sock2, r2 = self._open_client()
        sock2.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex2,
            "mode": "resume",
            "session_id": "shared-1",
        }) + "\n").encode())
        resp2 = self._read_frame(r2)
        self.assertEqual(resp2.get("type"), "transport_error")
        self.assertIn("locked", resp2.get("error", "").lower())
        r2.close()
        sock2.close()

        # Disconnect connection 1
        r1.close()
        sock1.close()

        # Wait boundedly for lock release
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            with self.server.lock:
                if ex1 not in self.server.active_executors and shared_cwd not in self.server.active_cwds:
                    break
            time.sleep(0.05)

        # Connection 2 now successfully resumes with its different executor ID
        sock3, r3 = self._open_client()
        sock3.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex2,
            "mode": "resume",
            "session_id": "shared-1",
        }) + "\n").encode())
        resp3 = self._read_frame(r3)
        self.assertEqual(resp3.get("type"), "connected")
        self.assertEqual(resp3.get("resumed"), True)
        r3.close()
        sock3.close()
    def test_workspace_containment_and_symlink_rejection(self) -> None:
        bad_ex = "c" * 64
        outside = tempfile.mkdtemp(prefix="outside_")
        try:
            os.symlink(outside, os.path.join(self.root_dir, bad_ex))
            sock, r = self._open_client()
            sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": bad_ex, "mode": "new"}) + "\n").encode())
            resp = self._read_frame(r)
            self.assertEqual(resp.get("type"), "transport_error")
            r.close()
            sock.close()
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_missing_operator_config_fails(self) -> None:
        self.server.operator_config = "/nonexistent/config.yml"
        sock, r = self._open_client()
        sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": "9" * 64, "mode": "new"}) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        self.server.operator_config = None
        r.close()
        sock.close()

    def test_catalog_listing_and_pagination(self) -> None:
        work1 = os.path.join(self.test_dir, "proj1")
        os.makedirs(work1, exist_ok=True)
        work2 = os.path.join(self.test_dir, "proj2")
        os.makedirs(work2, exist_ok=True)

        # 1. Main session with title and messages
        main_p = os.path.join(self.native_sessions_dir, "main.jsonl")
        with open(main_p, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "title", "title": "Session One Title"}) + "\n")
            f.write(json.dumps({"type": "session", "id": "uuid-main-1", "cwd": work1}) + "\n")
            f.write(json.dumps({"type": "message", "message": {"role": "user", "content": "hi"}}) + "\n")

        # 2. Empty valid session (header only, 0 messages)
        empty_p = os.path.join(self.native_sessions_dir, "empty.jsonl")
        with open(empty_p, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "session", "id": "uuid-empty-2", "cwd": work2}) + "\n")

        # 3. Subagent / saved branch session in a nested subdir
        sub_dir = os.path.join(self.native_sessions_dir, "nested_sub")
        os.makedirs(sub_dir, exist_ok=True)
        sub_p = os.path.join(sub_dir, "subagent.jsonl")
        with open(sub_p, "w", encoding="utf-8") as f:
            f.write(json.dumps({
                "type": "session",
                "id": "uuid-sub-3",
                "cwd": work1,
                "parentSession": str(main_p),
            }) + "\n")

        # 4. Corrupted session (invalid JSON line)
        corrupt_p = os.path.join(self.native_sessions_dir, "corrupt.jsonl")
        with open(corrupt_p, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "session", "id": "uuid-corrupt", "cwd": work1}) + "\n")
            f.write("{broken-json\n")

        # 5. Invalid session (missing cwd and id)
        invalid_p = os.path.join(self.native_sessions_dir, "invalid.jsonl")
        with open(invalid_p, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "other_event"}) + "\n")

        # 6. Symlink to session file (must NOT be indexed)
        symlink_p = os.path.join(self.native_sessions_dir, "symlink.jsonl")
        try:
            os.symlink(main_p, symlink_p)
        except OSError:
            pass

        # Query catalog
        sock, r = self._open_client()
        sock.sendall((json.dumps({"type": "sessions", "token": self.token, "offset": 0, "limit": 50}) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "sessions")
        sessions = resp.get("sessions", [])
        total = resp.get("total", 0)

        # Corrupt, invalid, and symlinks must NOT be in catalog; exactly 3 valid sessions
        self.assertEqual(total, 3)
        self.assertEqual(len(sessions), 3)

        s_ids = {s["session_id"] for s in sessions}
        self.assertEqual(s_ids, {"uuid-main-1", "uuid-empty-2", "uuid-sub-3"})

        main_entry = next(s for s in sessions if s["session_id"] == "uuid-main-1")
        self.assertEqual(main_entry.get("name"), "Session One Title")
        self.assertNotIn("parent_session", main_entry)

        empty_entry = next(s for s in sessions if s["session_id"] == "uuid-empty-2")
        self.assertEqual(empty_entry.get("session_id"), "uuid-empty-2")

        sub_entry = next(s for s in sessions if s["session_id"] == "uuid-sub-3")
        self.assertEqual(sub_entry.get("parent_session"), str(main_p))

        r.close()
        sock.close()

        # Test pagination
        sock, r = self._open_client()
        sock.sendall((json.dumps({"type": "sessions", "token": self.token, "offset": 1, "limit": 1}) + "\n").encode())
        paged_resp = self._read_frame(r)
        self.assertEqual(paged_resp.get("total"), 3)
        self.assertEqual(len(paged_resp.get("sessions", [])), 1)
        self.assertEqual(paged_resp.get("offset"), 1)
        self.assertEqual(paged_resp.get("limit"), 1)
        r.close()
        sock.close()

        # Test limit validation
        sock, r = self._open_client()
        sock.sendall((json.dumps({"type": "sessions", "token": self.token, "limit": 0}) + "\n").encode())
        err_resp = self._read_frame(r)
        self.assertEqual(err_resp.get("type"), "transport_error")
        r.close()
        sock.close()

    def test_new_mode_behavior(self) -> None:
        ex = "d" * 64
        # 1. Fresh new mode connects with default managed workspace
        sock, r = self._open_client()
        sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": ex, "mode": "new"}) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "connected")
        self.assertFalse(resp.get("resumed"))
        self.assertIsNone(resp.get("session_file"))
        self.assertEqual(resp.get("workdir"), os.path.realpath(os.path.join(self.root_dir, ex)))

        ready = self._read_frame(r)
        self.assertEqual(ready.get("type"), "ready")
        r.close()
        sock.close()

        # Wait boundedly for lock release
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            with self.server.lock:
                if ex not in self.server.active_executors:
                    break
            time.sleep(0.05)

        # 2. Fresh new mode with explicit custom cwd (existing absolute worker directory)
        custom_cwd = os.path.join(self.test_dir, "custom_worker_proj")
        os.makedirs(custom_cwd, exist_ok=True)
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex,
            "mode": "new",
            "cwd": custom_cwd,
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "connected")
        self.assertFalse(resp.get("resumed"))
        self.assertEqual(resp.get("workdir"), os.path.realpath(custom_cwd))

        # Concurrent connection with DIFFERENT executor ID on same custom cwd fails with locked
        sock_conflict, r_conflict = self._open_client()
        sock_conflict.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "3" * 64,
            "mode": "new",
            "cwd": custom_cwd,
        }) + "\n").encode())
        resp_conflict = self._read_frame(r_conflict)
        self.assertEqual(resp_conflict.get("type"), "transport_error")
        self.assertIn("locked", resp_conflict.get("error", "").lower())
        r_conflict.close()
        sock_conflict.close()

        r.close()
        sock.close()

        # Wait boundedly for lock release
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            with self.server.lock:
                if ex not in self.server.active_executors and custom_cwd not in self.server.active_cwds:
                    break
            time.sleep(0.05)

        # 3. Invalid custom cwd checks
        # 3a. Relative cwd rejected
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex,
            "mode": "new",
            "cwd": "relative/path/not/allowed",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

        # 3b. Nonexistent directory rejected
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex,
            "mode": "new",
            "cwd": os.path.join(self.test_dir, "nonexistent_dir"),
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

        # 3c. Symlink cwd rejected
        symlink_cwd = os.path.join(self.test_dir, "symlink_cwd")
        try:
            os.symlink(custom_cwd, symlink_cwd)
            sock, r = self._open_client()
            sock.sendall((json.dumps({
                "type": "connect",
                "token": self.token,
                "executor": ex,
                "mode": "new",
                "cwd": symlink_cwd,
            }) + "\n").encode())
            resp = self._read_frame(r)
            self.assertEqual(resp.get("type"), "transport_error")
            r.close()
            sock.close()
        finally:
            if os.path.islink(symlink_cwd):
                os.unlink(symlink_cwd)

        # 4. Mode new with session_id selector rejected
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "e" * 64,
            "mode": "new",
            "session_id": "some-id",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

    def test_resume_mode_by_id_and_file(self) -> None:
        ex = "f" * 64
        workdir = os.path.join(self.test_dir, "resume_target_dir")
        os.makedirs(workdir, exist_ok=True)
        session_p = os.path.join(self.native_sessions_dir, "target_session.jsonl")
        with open(session_p, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "session", "id": "target-uuid-123", "cwd": workdir}) + "\n")

        # 1. Resume by session_id
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex,
            "mode": "resume",
            "session_id": "target-uuid-123",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "connected")
        self.assertTrue(resp.get("resumed"))
        self.assertEqual(resp.get("session_file"), os.path.realpath(session_p))
        self.assertEqual(resp.get("workdir"), os.path.realpath(workdir))
        r.close()
        sock.close()

        # Wait boundedly for lock release
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            with self.server.lock:
                if ex not in self.server.active_executors:
                    break
            time.sleep(0.05)

        # 2. Resume by session_file
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex,
            "mode": "resume",
            "session_file": os.path.realpath(session_p),
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "connected")
        self.assertTrue(resp.get("resumed"))
        self.assertEqual(resp.get("session_file"), os.path.realpath(session_p))
        self.assertEqual(resp.get("workdir"), os.path.realpath(workdir))
        r.close()
        sock.close()

        # Wait boundedly for lock release
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            with self.server.lock:
                if ex not in self.server.active_executors:
                    break
            time.sleep(0.05)

        # 3. Resume matching both session_id and session_file
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": ex,
            "mode": "resume",
            "session_id": "target-uuid-123",
            "session_file": os.path.realpath(session_p),
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "connected")
        self.assertTrue(resp.get("resumed"))
        r.close()
        sock.close()

        # 4. Resume with mismatched session_id and session_file fails
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "9" * 64,
            "mode": "resume",
            "session_id": "wrong-id",
            "session_file": os.path.realpath(session_p),
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

        # 5. Resume mode without any selector fails
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "9" * 64,
            "mode": "resume",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

        # 6. Resume mode with supplied cwd rejected
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "9" * 64,
            "mode": "resume",
            "session_id": "target-uuid-123",
            "cwd": workdir,
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        self.assertIn("cwd", resp.get("error", "").lower())
        r.close()
        sock.close()

        # 7. Resume mode with relative session_file rejected
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "9" * 64,
            "mode": "resume",
            "session_file": "relative/path.jsonl",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

        # 8. Resume mode with symlink session_file rejected (not silently canonicalized)
        symlink_sfile = os.path.join(self.test_dir, "symlink_session.jsonl")
        try:
            os.symlink(session_p, symlink_sfile)
            sock, r = self._open_client()
            sock.sendall((json.dumps({
                "type": "connect",
                "token": self.token,
                "executor": "9" * 64,
                "mode": "resume",
                "session_file": symlink_sfile,
            }) + "\n").encode())
            resp = self._read_frame(r)
            self.assertEqual(resp.get("type"), "transport_error")
            r.close()
            sock.close()
        finally:
            if os.path.islink(symlink_sfile):
                os.unlink(symlink_sfile)
    def test_resume_fail_closed_no_fresh_fallback(self) -> None:
        # Nonexistent session ID must fail-closed, NEVER fresh fallback
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "8" * 64,
            "mode": "resume",
            "session_id": "nonexistent-uuid-999",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

        # Non-catalog arbitrary path must fail-closed
        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "8" * 64,
            "mode": "resume",
            "session_file": "/etc/hosts",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        r.close()
        sock.close()

    def test_ambiguous_session_id_rejected(self) -> None:
        dir1 = os.path.join(self.native_sessions_dir, "d1")
        dir2 = os.path.join(self.native_sessions_dir, "d2")
        os.makedirs(dir1, exist_ok=True)
        os.makedirs(dir2, exist_ok=True)
        w = os.path.join(self.test_dir, "amb_work")
        os.makedirs(w, exist_ok=True)

        with open(os.path.join(dir1, "s1.jsonl"), "w") as f:
            f.write(json.dumps({"type": "session", "id": "duplicate-uuid", "cwd": w}) + "\n")
        with open(os.path.join(dir2, "s2.jsonl"), "w") as f:
            f.write(json.dumps({"type": "session", "id": "duplicate-uuid", "cwd": w}) + "\n")

        sock, r = self._open_client()
        sock.sendall((json.dumps({
            "type": "connect",
            "token": self.token,
            "executor": "7" * 64,
            "mode": "resume",
            "session_id": "duplicate-uuid",
        }) + "\n").encode())
        resp = self._read_frame(r)
        self.assertEqual(resp.get("type"), "transport_error")
        self.assertIn("ambiguous", resp.get("error", "").lower())
        r.close()
        sock.close()
    def test_relay_coalesced_and_agent_end_non_closing(self) -> None:
        sock, r = self._open_client()
        sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": "e" * 64, "mode": "new"}) + "\n").encode())

        connected = self._read_frame(r)
        self.assertEqual(connected.get("type"), "connected")
        ready = self._read_frame(r)
        self.assertEqual(ready.get("type"), "ready")

        sock.sendall((json.dumps({"id": "1", "type": "test_agent_end"}) + "\n").encode())
        ae = self._read_frame(r)
        self.assertEqual(ae.get("type"), "agent_end")

        sock.sendall((json.dumps({"id": "2", "type": "test_chunk"}) + "\n").encode())
        chunk = self._read_frame(r)
        self.assertEqual(chunk.get("type"), "rpc_chunk")

        sock.shutdown(socket.SHUT_WR)
        r.close()
        sock.close()

    def test_child_exit_without_client_close_releases_lock(self) -> None:
        ex = "7" * 64
        os.environ["FAKE_OMP_MODE"] = "ready_then_crash"
        try:
            sock, r = self._open_client()
            sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": ex, "mode": "new"}) + "\n").encode())
            self._read_frame(r)  # connected
            self._read_frame(r)  # ready

            # Child process crashes after emitting ready.
            # Client reads EOF on stdout reader without closing its input/socket:
            eof_line = r.readline()
            self.assertEqual(eof_line, "")

            # Verify that server boundedly reaps child and releases executor lock
            # even though client has NOT closed sock!
            deadline = time.monotonic() + 3.0
            lock_released = False
            while time.monotonic() < deadline:
                with self.server.lock:
                    if ex not in self.server.active_executors:
                        lock_released = True
                        break
                time.sleep(0.05)
            self.assertTrue(lock_released, "Executor lock must be released when child terminates, even if client input is open")

            r.close()
            sock.close()
        finally:
            os.environ.pop("FAKE_OMP_MODE", None)

    def test_process_group_cleanup_including_descendants(self) -> None:
        os.environ["FAKE_OMP_MODE"] = "spawn_children"
        try:
            sock, r = self._open_client()
            sock.sendall((json.dumps({"type": "connect", "token": self.token, "executor": "f" * 64, "mode": "new"}) + "\n").encode())
            self._read_frame(r)
            self._read_frame(r)

            procs = list(self.server.active_procs.values())
            self.assertEqual(len(procs), 1)
            pgid, proc = procs[0]

            r.close()
            sock.close()

            # Bounded wait verifying process group is reaped and not actively executing
            deadline = time.monotonic() + 4.0
            group_gone = False
            while time.monotonic() < deadline:
                try:
                    os.killpg(pgid, 0)
                    any_executing = False
                    try:
                        for pentry in os.listdir("/proc"):
                            if pentry.isdigit():
                                try:
                                    with open(f"/proc/{pentry}/stat", "r") as f:
                                        fields = f.read().split()
                                        if len(fields) > 4 and int(fields[4]) == pgid:
                                            if fields[2] != "Z":
                                                any_executing = True
                                                break
                                except (OSError, IndexError, ValueError):
                                    continue
                    except OSError:
                        pass
                    if not any_executing:
                        group_gone = True
                        break
                except (ProcessLookupError, PermissionError):
                    group_gone = True
                    break
                time.sleep(0.05)

            self.assertTrue(group_gone, "Process group must not have living executing descendants")
        finally:
            os.environ.pop("FAKE_OMP_MODE", None)

    def test_tunnel_refuses_incompatible_or_wrong_session_ack_before_forwarding(self) -> None:
        cases = [
            ("new", {"resumed": False}, []),
            ("new", {"resumed": True, "session_file": "/tmp/existing.jsonl"}, []),
            ("resume", {"resumed": False, "session_file": None}, ["--session-id", "selected"]),
            ("resume", {"resumed": True, "session_file": "/tmp/other.jsonl"}, ["--session-file", "/tmp/selected.jsonl"]),
        ]
        for mode, acknowledgement, selectors in cases:
            with self.subTest(mode=mode, acknowledgement=acknowledgement), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                listener.settimeout(4)
                forwarded = bytearray()

                def peer() -> None:
                    connection, _ = listener.accept()
                    with connection, connection.makefile("rb") as reader:
                        connection.settimeout(4)
                        reader.readline()
                        connection.sendall((json.dumps({"type": "connected", "executor": "1" * 64, **acknowledgement})
                                            + '\n{"type":"ready"}\n').encode())
                        try:
                            forwarded.extend(reader.read())
                        except ConnectionResetError:
                            pass

                thread = threading.Thread(target=peer)
                thread.start()
                result = subprocess.run(
                    [sys.executable, str(DEPLOY_DIR / "tcp_stdio.py"), "--executor", "1" * 64, "--mode", mode, *selectors],
                    input=b'{"type":"prompt","message":"Do not forward to the wrong session"}\n',
                    capture_output=True, timeout=5,
                    env={**os.environ, "OMP_EXECUTOR_TOKEN": self.token, "OMP_EXECUTOR_HOST": "127.0.0.1",
                         "OMP_EXECUTOR_PORT": str(listener.getsockname()[1])},
                )
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(forwarded, b"")

    def test_tunnel_clean_eof_and_early_exit(self) -> None:
        tunnel_py = DEPLOY_DIR / "tcp_stdio.py"
        env = {
            **os.environ,
            "OMP_EXECUTOR_TOKEN": self.token,
            "OMP_EXECUTOR_HOST": "127.0.0.1",
            "OMP_EXECUTOR_PORT": str(self.server_port),
        }

        # 1. Catalog list-sessions mode
        p_cat = subprocess.Popen(
            [sys.executable, str(tunnel_py), "--list-sessions"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        cat_out, cat_err = p_cat.communicate(timeout=3.0)
        self.assertEqual(p_cat.returncode, 0)
        cat_json = json.loads(cat_out.decode("utf-8"))
        self.assertEqual(cat_json.get("type"), "sessions")
        self.assertIn("sessions", cat_json)

        # 2. Normal EOF in new mode
        p = subprocess.Popen(
            [sys.executable, str(tunnel_py), "--executor", "1" * 64, "--mode", "new"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        ready_line = p.stdout.readline().decode()
        self.assertEqual(json.loads(ready_line).get("type"), "ready")

        p.stdin.write((json.dumps({"id": "t1", "type": "ping"}) + "\n").encode())
        p.stdin.flush()
        resp_line = p.stdout.readline().decode()
        self.assertTrue(json.loads(resp_line).get("success"))

        p.stdin.close()
        self.assertEqual(p.wait(timeout=3.0), 0)
        p.stdout.close()
        p.stderr.close()

        # 3. Tunnel CLI validation rejections
        p_bad = subprocess.Popen(
            [sys.executable, str(tunnel_py), "--executor", "1" * 64],  # missing --mode
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.assertNotEqual(p_bad.wait(timeout=3.0), 0)
        p_bad.stdout.close()
        p_bad.stderr.close()

        # 3b. Tunnel with --cwd in resume mode rejected
        p_cwd_bad = subprocess.Popen(
            [sys.executable, str(tunnel_py), "--executor", "1" * 64, "--mode", "resume", "--cwd", self.test_dir, "--session-id", "some-id"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.assertNotEqual(p_cwd_bad.wait(timeout=3.0), 0)
        p_cwd_bad.stdout.close()
        p_cwd_bad.stderr.close()

        # 3c. Tunnel with relative --session-file rejected
        p_sfile_bad = subprocess.Popen(
            [sys.executable, str(tunnel_py), "--executor", "1" * 64, "--mode", "resume", "--session-file", "relative/path.jsonl"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.assertNotEqual(p_sfile_bad.wait(timeout=3.0), 0)
        p_sfile_bad.stdout.close()
        p_sfile_bad.stderr.close()

        # 3d. Tunnel with valid --cwd in new mode succeeds
        custom_tunnel_cwd = os.path.join(self.test_dir, "tunnel_custom_cwd")
        os.makedirs(custom_tunnel_cwd, exist_ok=True)
        p_cwd_good = subprocess.Popen(
            [sys.executable, str(tunnel_py), "--executor", "3" * 64, "--mode", "new", "--cwd", custom_tunnel_cwd],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        ready_good = p_cwd_good.stdout.readline().decode()
        self.assertEqual(json.loads(ready_good).get("type"), "ready")
        p_cwd_good.stdin.close()
        self.assertEqual(p_cwd_good.wait(timeout=3.0), 0)
        p_cwd_good.stdout.close()
        p_cwd_good.stderr.close()
        # 4. Early remote crash propagates nonzero exit
        os.environ["FAKE_OMP_MODE"] = "ready_then_crash"
        try:
            p2 = subprocess.Popen(
                [sys.executable, str(tunnel_py), "--executor", "2" * 64, "--mode", "new"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            p2.stdout.readline()  # ready
            self.assertNotEqual(p2.wait(timeout=3.0), 0)
            p2.stdin.close()
            p2.stdout.close()
            p2.stderr.close()
        finally:
            os.environ.pop("FAKE_OMP_MODE", None)

if __name__ == "__main__":
    unittest.main()
