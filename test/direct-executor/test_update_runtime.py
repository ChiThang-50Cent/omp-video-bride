#!/usr/bin/env python3
"""Behavioral tests for tools/update-runtime.py.

Validates read-only check mode, candidate preparation for OMP and Hermes,
immutable tag peeling, publisher checksum verification, coupled lock integrity,
staged atomic writes with sequential rollback, concurrent modification guards,
preservation of unrelated pins, and avoidance of silent native plugin allowlist migrations.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

TOOLS_DIR = Path(__file__).resolve().parents[2] / "tools"
UPDATER_PATH = TOOLS_DIR / "update-runtime.py"

spec = importlib.util.spec_from_file_location("update_runtime", UPDATER_PATH)
if spec is None or spec.loader is None:
    raise ImportError(f"Cannot load update-runtime.py from {UPDATER_PATH}")
update_runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update_runtime)


class MockHttpResponse:
    """Mock standard urllib HTTP response object."""

    def __init__(self, data: bytes, code: int = 200, headers: Optional[dict] = None) -> None:
        self._data = data
        self.code = code
        self.headers = headers or {}

    def read(self, n: int = -1) -> bytes:
        if n == -1:
            ret = self._data
            self._data = b""
            return ret
        ret = self._data[:n]
        self._data = self._data[n:]
        return ret

    def geturl(self) -> str:
        return "https://api.github.com/mock"

    def __enter__(self) -> MockHttpResponse:
        return self

    def __exit__(self, *args) -> None:
        pass


def make_tar_bytes(files: dict[str, bytes]) -> bytes:
    """Helper to generate in-memory .tar.gz bytes."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in files.items():
            ti = tarfile.TarInfo(name=name)
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


class BaseRuntimeUpdaterTest(unittest.TestCase):
    """Base test case providing an isolated test repository fixture."""

    def setUp(self) -> None:
        self.test_dir = tempfile.mkdtemp(prefix="omp_test_updater_")
        self.repo_dir = Path(self.test_dir) / "repo"
        self.repo_dir.mkdir(parents=True)

        self.deploy_dir = self.repo_dir / "deploy"
        self.hermes_dir = self.deploy_dir / "hermes"
        self.hermes_dir.mkdir(parents=True)

        self.initial_runtime_lock = {
            "platform": "linux/amd64",
            "versions": {
                "node": "22.20.0",
                "omp": "18.4.4",
                "hyperframes": "0.8.82",
                "chrome": "156.0.8075.0",
                "whisperSource": "d09f61a708f3487afa956ff578e60eae5e7a233c",
                "hermesSource": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
            },
            "runtimeInputs": {
                "node": {
                    "url": "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz",
                    "sha256": "00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc",
                },
                "omp": {
                    "url": "https://github.com/can1357/oh-my-pi/releases/download/v18.4.4/omp-linux-x64",
                    "sha256": "24c830fceb0bd6884bf5bf2c7a2b7407bc23fafe655e924c695ef9be308e46f3",
                    "kind": "file",
                    "destination": "omp",
                    "mode": 493,
                },
                "whisper": {
                    "sha256": "750655899a32d5bb5b04bbde9afa430f851d46718f53812a4ec086537fee3ef8",
                },
                "skills": {
                    "sha256": "43223e60336b1bec641b18429e1c8bbd963ed30404c93b62bee7a384c4d71613",
                },
                "media-use": {
                    "sha256": "260f875423345e50f0ac81fd0c7c62bd0469a98735795479fc9a5392f4eb5f45",
                },
            },
            "assets": {
                "models": {
                    "kokoro": {"sha256": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"},
                    "voices": {"sha256": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"},
                    "whisper-small.en": {"sha256": "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d"},
                },
                "chrome": {"binarySha256": "ba90c0d07ea57016fd18a95bf038d75958e1fd859537b82a47a459bb020700de"},
            },
            "hermes": {
                "sourceUrl": "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/f97608f178d1ffeca59860195ab7da295f7c8e5f",
                "sourceSha256": "babbdb9706ad1c96708d75914afb45d809cd4b73dec1ceae233a6814f5ed97e3",
                "sqliteVersion": "3.53.4",
                "sqliteSha256": "0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c",
            },
            "notes": [
                "Tested snapshot note.",
            ],
        }

        self.initial_omp_rpc_lock = {
            "version": "18.4.4",
            "commit": "8ac1309bd8adaddc891eeb389c545345073875be",
            "sourcePath": "python/omp-rpc",
            "files": {
                "__init__.py": "2bdfbf8744fbc43aeda48ce9eccc27181c78bbd1e9c5490e96929d8d08b27d10",
                "client.py": "3c393412776420064d0f6dc56c72fd37ea3abe71e59355e3a2fd0e744142ba4c",
                "protocol.py": "18bc58a2a50ae7d6cd4e4b87b1ee2701e467561429b251f73f39803ce370ef0c",
                "host_tools.py": "7e0036b1fcf5fdedec9c7011d6a428a9dd0de670d4ed700aa9d788dad35b4797",
                "host_uris.py": "2b5c73c6ca528d2be705e6020c1768856fd76b67641eafd33109dbacbed63ade",
                "py.typed": "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b",
            },
            "licenseSha256": "048c9ebb09976a1c2e895d23f91dbe9114bd7858bfd7ff3b6a8f957feccbdfeb",
        }

        self.runtime_lock_file = self.deploy_dir / "runtime-lock.json"
        self.omp_rpc_lock_file = self.hermes_dir / "omp-rpc-lock.json"

        self.runtime_lock_file.write_text(json.dumps(self.initial_runtime_lock, indent=2) + "\n", encoding="utf-8")
        self.omp_rpc_lock_file.write_text(json.dumps(self.initial_omp_rpc_lock, indent=2) + "\n", encoding="utf-8")

        # Plugin executor.py with SUPPORTED_COMMANDS allowlist
        self.plugin_dir = self.repo_dir / "hermes-plugin" / "omp-executor"
        self.plugin_dir.mkdir(parents=True)
        self.plugin_executor_file = self.plugin_dir / "executor.py"
        self.plugin_executor_file.write_text(
            'SUPPORTED_COMMANDS: frozenset[str] = frozenset({\n'
            '    "negotiate_protocol",\n'
            '    "prompt",\n'
            '    "abort",\n'
            '})\n',
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.test_dir, ignore_errors=True)


class TestCheckCommand(BaseRuntimeUpdaterTest):
    """Behavioral tests for 'check' read-only inspection."""

    @patch("urllib.request.urlopen")
    def test_check_up_to_date(self, mock_urlopen: MagicMock) -> None:
        """When upstream versions match current pins, report up to date."""
        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "can1357/oh-my-pi/releases/latest" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.4.4",
                    "published_at": "2026-09-20T10:00:00Z",
                }).encode("utf-8"))
            if "NousResearch/hermes-agent/releases/latest" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v2026.9.24",
                    "published_at": "2026-09-24T10:00:00Z",
                }).encode("utf-8"))
            if "NousResearch/hermes-agent/git/ref/tags/v2026.9.24" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "f97608f178d1ffeca59860195ab7da295f7c8e5f", "type": "commit"}
                }).encode("utf-8"))
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        result = update_runtime.check_runtime(self.repo_dir)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["omp"]["current_version"], "18.4.4")
        self.assertEqual(result["omp"]["latest_version"], "18.4.4")
        self.assertFalse(result["omp"]["update_available"])

        self.assertEqual(result["hermes"]["current_commit"], "f97608f178d1ffeca59860195ab7da295f7c8e5f")
        self.assertEqual(result["hermes"]["latest_commit"], "f97608f178d1ffeca59860195ab7da295f7c8e5f")
        self.assertFalse(result["hermes"]["update_available"])
        self.assertTrue(result["coupled_locks"]["synchronized"])

    @patch("urllib.request.urlopen")
    def test_check_update_available(self, mock_urlopen: MagicMock) -> None:
        """When upstream has newer releases, report update available."""
        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "can1357/oh-my-pi/releases/latest" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.6.0",
                    "published_at": "2026-09-30T12:00:00Z",
                }).encode("utf-8"))
            if "NousResearch/hermes-agent/releases/latest" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v2026.10.01",
                    "published_at": "2026-10-01T12:00:00Z",
                }).encode("utf-8"))
            if "NousResearch/hermes-agent/git/ref/tags/v2026.10.01" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "1111111111111111111111111111111111111111", "type": "commit"}
                }).encode("utf-8"))
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        result = update_runtime.check_runtime(self.repo_dir)
        self.assertTrue(result["omp"]["update_available"])
        self.assertEqual(result["omp"]["latest_version"], "18.6.0")
        self.assertTrue(result["hermes"]["update_available"])
        self.assertEqual(result["hermes"]["latest_commit"], "1111111111111111111111111111111111111111")

    @patch("urllib.request.urlopen")
    def test_check_hermes_fallback_default_branch(self, mock_urlopen: MagicMock) -> None:
        """If Hermes has no stable releases, fall back to default branch commit and report clearly."""
        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "can1357/oh-my-pi/releases/latest" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.4.4",
                    "published_at": "2026-09-20T10:00:00Z",
                }).encode("utf-8"))
            if "NousResearch/hermes-agent/releases/latest" in url:
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))
            if url == "https://api.github.com/repos/NousResearch/hermes-agent":
                return MockHttpResponse(json.dumps({"default_branch": "main"}).encode("utf-8"))
            if "NousResearch/hermes-agent/git/ref/heads/main" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "2222222222222222222222222222222222222222", "type": "commit"}
                }).encode("utf-8"))
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        result = update_runtime.check_runtime(self.repo_dir)
        self.assertTrue(result["hermes"]["is_default_branch_fallback"])
        self.assertIn("not a stable release version", result["hermes"]["note"])
        self.assertEqual(result["hermes"]["latest_commit"], "2222222222222222222222222222222222222222")

    @patch("urllib.request.urlopen")
    def test_check_is_strictly_read_only(self, mock_urlopen: MagicMock) -> None:
        """Check mode must NEVER modify files on disk."""
        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "can1357/oh-my-pi/releases/latest" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.4.4",
                    "published_at": "2026-09-20T10:00:00Z",
                }).encode("utf-8"))
            if "NousResearch/hermes-agent/releases/latest" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v2026.9.24",
                    "published_at": "2026-09-24T10:00:00Z",
                }).encode("utf-8"))
            if "NousResearch/hermes-agent/git/ref/tags/v2026.9.24" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "f97608f178d1ffeca59860195ab7da295f7c8e5f", "type": "commit"}
                }).encode("utf-8"))
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        initial_runtime_bytes = self.runtime_lock_file.read_bytes()
        initial_omp_rpc_bytes = self.omp_rpc_lock_file.read_bytes()

        update_runtime.check_runtime(self.repo_dir)

        self.assertEqual(self.runtime_lock_file.read_bytes(), initial_runtime_bytes)
        self.assertEqual(self.omp_rpc_lock_file.read_bytes(), initial_omp_rpc_bytes)

    def test_check_coupled_lock_mismatch_detected(self) -> None:
        """If existing runtime-lock.json and omp-rpc-lock.json differ in version, check fails."""
        data = json.loads(self.omp_rpc_lock_file.read_text())
        data["version"] = "18.3.0"
        self.omp_rpc_lock_file.write_text(json.dumps(data, indent=2) + "\n")

        with self.assertRaises(update_runtime.CoupledLockMismatchError):
            update_runtime.check_runtime(self.repo_dir)


class TestPrepareOmp(BaseRuntimeUpdaterTest):
    """Behavioral tests for 'prepare omp' candidate preparation."""

    @patch("urllib.request.urlopen")
    def test_prepare_omp_happy_path_with_publisher_digest(self, mock_urlopen: MagicMock) -> None:
        """Full successful OMP prepare verifying publisher SHA256SUMS.txt."""
        fake_binary = b"ELF-MOCK-OMP-BINARY-BYTES-18.6.0"
        binary_sha = hashlib.sha256(fake_binary).hexdigest()
        sha256sums_content = f"{binary_sha}  omp-linux-x64\n1111  other-asset\n".encode("utf-8")

        fake_old_client_py = b"class RpcClient:\n    def old_method(self):\n        pass\n"
        fake_client_py = b"class RpcClient:\n    def old_method(self):\n        pass\n    def new_feature_method(self, arg1, opt=None):\n        pass\n"
        fake_protocol_py = b"# protocol types\n"
        fake_init_py = b"__version__ = '18.6.0'\n"
        fake_license = b"Apache-2.0 License\n"

        ts_content = (
            b"export type RpcCommand =\n"
            b"\t| { id?: string; type: \"prompt\"; message: string }\n"
            b"\t| { id?: string; type: \"abort\" }\n"
            b"\t| {\n"
            b"\t\tid?: string;\n"
            b"\t\ttype: \"goal\";\n"
            b"\t\top: string;\n"
            b"\t  }\n"
            b"\t| { id?: string; type: \"new_future_command\" };\n"
            b"\n"
            b"export interface RpcSessionState {\n"
            b"\tmodel?: Model;\n"
            b"}\n"
        )

        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "releases/tags/v18.6.0" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.6.0",
                    "assets": [
                        {
                            "name": "SHA256SUMS.txt",
                            "browser_download_url": "https://github.com/mock/SHA256SUMS.txt",
                        },
                        {
                            "name": "omp-linux-x64",
                            "browser_download_url": "https://github.com/mock/omp-linux-x64",
                        },
                    ],
                }).encode("utf-8"))
            if url == "https://github.com/mock/SHA256SUMS.txt":
                return MockHttpResponse(sha256sums_content)
            if "releases/download/v18.6.0/omp-linux-x64" in url:
                return MockHttpResponse(fake_binary)
            if "git/ref/tags/v18.6.0" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "3333333333333333333333333333333333333333", "type": "commit"}
                }).encode("utf-8"))
            if "trees/3333333333333333333333333333333333333333" in url:
                return MockHttpResponse(json.dumps({
                    "tree": [
                        {"path": "python/omp-rpc/src/omp_rpc/__init__.py", "type": "blob"},
                        {"path": "python/omp-rpc/src/omp_rpc/client.py", "type": "blob"},
                        {"path": "python/omp-rpc/src/omp_rpc/protocol.py", "type": "blob"},
                        {"path": "python/omp-rpc/LICENSE", "type": "blob"},
                    ]
                }).encode("utf-8"))
            if "python/omp-rpc/src/omp_rpc/__init__.py" in url:
                return MockHttpResponse(fake_init_py)
            if "3333333333333333333333333333333333333333/python/omp-rpc/src/omp_rpc/client.py" in url:
                return MockHttpResponse(fake_client_py)
            if "8ac1309bd8adaddc891eeb389c545345073875be/python/omp-rpc/src/omp_rpc/client.py" in url:
                return MockHttpResponse(fake_old_client_py)
            if "python/omp-rpc/src/omp_rpc/protocol.py" in url:
                return MockHttpResponse(fake_protocol_py)
            if "python/omp-rpc/LICENSE" in url:
                return MockHttpResponse(fake_license)
            if "packages/coding-agent/src/modes/rpc/rpc-types.ts" in url:
                return MockHttpResponse(ts_content)
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        result = update_runtime.prepare_omp(self.repo_dir, version="18.6.0")

        self.assertEqual(result["status"], "prepared")
        self.assertEqual(result["version"], "18.6.0")
        self.assertEqual(result["rpc_diff"]["commands_verification_status"], "verified")
        self.assertIn("new_future_command", result["rpc_diff"]["added_upstream_commands"])
        self.assertIn("goal", result["rpc_diff"]["added_upstream_commands"])

        # Check lock files updated on disk
        updated_runtime = json.loads(self.runtime_lock_file.read_text())
        self.assertEqual(updated_runtime["versions"]["omp"], "18.6.0")
        self.assertEqual(updated_runtime["runtimeInputs"]["omp"]["sha256"], binary_sha)

        updated_rpc = json.loads(self.omp_rpc_lock_file.read_text())
        self.assertEqual(updated_rpc["version"], "18.6.0")
        self.assertEqual(updated_rpc["commit"], "3333333333333333333333333333333333333333")
        self.assertEqual(updated_rpc["sourcePath"], "python/omp-rpc")
        self.assertIn("client.py", updated_rpc["files"])

        # Check plugin allowlist was NOT modified
        plugin_content = self.plugin_executor_file.read_text()
        self.assertIn('"negotiate_protocol"', plugin_content)
        self.assertNotIn("new_future_command", plugin_content)

    @patch("urllib.request.urlopen")
    def test_prepare_omp_publisher_digest_missing_entry_rejected(self, mock_urlopen: MagicMock) -> None:
        """When publisher digest asset is present but lacks entry for omp-linux-x64, reject without modifying."""
        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "releases/tags/v18.5.0" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.5.0",
                    "assets": [
                        {"name": "SHA256SUMS.txt", "browser_download_url": "https://github.com/mock/SHA256SUMS.txt"},
                        {"name": "omp-linux-x64", "browser_download_url": "https://github.com/mock/omp-linux-x64"},
                    ],
                }).encode("utf-8"))
            if "git/ref/tags/v18.5.0" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "4444444444444444444444444444444444444444", "type": "commit"}
                }).encode("utf-8"))
            if "SHA256SUMS.txt" in url:
                # Does NOT contain omp-linux-x64
                return MockHttpResponse(b"11112222  other-file\n")
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        orig_runtime_bytes = self.runtime_lock_file.read_bytes()
        orig_rpc_bytes = self.omp_rpc_lock_file.read_bytes()

        with self.assertRaises(update_runtime.DigestMismatchError):
            update_runtime.prepare_omp(self.repo_dir, version="18.5.0")

        self.assertEqual(self.runtime_lock_file.read_bytes(), orig_runtime_bytes)
        self.assertEqual(self.omp_rpc_lock_file.read_bytes(), orig_rpc_bytes)

    @patch("urllib.request.urlopen")
    def test_binary_metadata_digest_mismatch_preserves_both_locks(self, network):
        before = (self.runtime_lock_file.read_bytes(), self.omp_rpc_lock_file.read_bytes())

        def response(request, timeout=60):
            url = request.full_url
            if "/releases/tags/v18.6.0" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.6.0",
                    "assets": [{"name": "omp-linux-x64", "digest": "sha256:" + "0" * 64}],
                }).encode())
            if "/git/ref/tags/v18.6.0" in url:
                return MockHttpResponse(json.dumps({"object": {"sha": "a" * 40, "type": "commit"}}).encode())
            if "/releases/download/v18.6.0/omp-linux-x64" in url:
                return MockHttpResponse(b"binary with a different digest")
            raise AssertionError(f"Unexpected request after digest mismatch: {url}")

        network.side_effect = response
        with self.assertRaises(update_runtime.DigestMismatchError):
            update_runtime.prepare_omp(self.repo_dir, "18.6.0")
        self.assertEqual((self.runtime_lock_file.read_bytes(), self.omp_rpc_lock_file.read_bytes()), before)

    @patch("urllib.request.urlopen")
    def test_prepare_omp_tree_truncated_fails(self, mock_urlopen: MagicMock) -> None:
        """Truncated git tree response must fail without partial writes."""
        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "releases/tags/v18.5.0" in url:
                return MockHttpResponse(json.dumps({"tag_name": "v18.5.0", "assets": []}).encode("utf-8"))
            if "releases/download/v18.5.0/omp-linux-x64" in url:
                return MockHttpResponse(b"OMP-BINARY")
            if "git/ref/tags/v18.5.0" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "4444444444444444444444444444444444444444", "type": "commit"}
                }).encode("utf-8"))
            if "trees/4444444444444444444444444444444444444444" in url:
                return MockHttpResponse(json.dumps({"truncated": True, "tree": []}).encode("utf-8"))
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        orig_runtime = self.runtime_lock_file.read_bytes()
        with self.assertRaises(update_runtime.UpdateError):
            update_runtime.prepare_omp(self.repo_dir, version="18.5.0")
        self.assertEqual(self.runtime_lock_file.read_bytes(), orig_runtime)

    def test_prepare_omp_invalid_ambiguous_version_refusal(self) -> None:
        """Ambiguous or non-three-component version inputs (like '18.6' or 'latest') are refused, locks unchanged."""
        orig_runtime_bytes = self.runtime_lock_file.read_bytes()
        orig_rpc_bytes = self.omp_rpc_lock_file.read_bytes()

        for bad_ver in ["18.6", "latest", "18", "18.6.0.1", "v18.6"]:
            with self.assertRaises(update_runtime.UpdateError):
                update_runtime.prepare_omp(self.repo_dir, version=bad_ver)

        self.assertEqual(self.runtime_lock_file.read_bytes(), orig_runtime_bytes)
        self.assertEqual(self.omp_rpc_lock_file.read_bytes(), orig_rpc_bytes)

    @patch("urllib.request.urlopen")
    def test_prepare_omp_exact_three_component_with_sdk_source_path(self, mock_urlopen: MagicMock) -> None:
        """Passing exact '18.6.0' detects SDK sourcePath sdk/python/omp-rpc and emits sourcePath in candidate lock."""
        fake_binary = b"BINARY-18.6.0"
        binary_sha = hashlib.sha256(fake_binary).hexdigest()

        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if "releases/tags/v18.6.0" in url:
                return MockHttpResponse(json.dumps({
                    "tag_name": "v18.6.0",
                    "assets": [
                        {"name": "omp-linux-x64", "browser_download_url": "https://github.com/mock/omp-linux-x64"},
                    ],
                }).encode("utf-8"))
            if "releases/download/v18.6.0/omp-linux-x64" in url:
                return MockHttpResponse(fake_binary)
            if "git/ref/tags/v18.6.0" in url:
                return MockHttpResponse(json.dumps({
                    "object": {"sha": "89d2610993af69427574bde17791df63906ec4e5", "type": "commit"}
                }).encode("utf-8"))
            if "trees/89d2610993af69427574bde17791df63906ec4e5" in url:
                return MockHttpResponse(json.dumps({
                    "tree": [
                        {"path": "sdk/python/omp-rpc/src/omp_rpc/__init__.py", "type": "blob"},
                        {"path": "sdk/python/omp-rpc/src/omp_rpc/client.py", "type": "blob"},
                        {"path": "sdk/python/omp-rpc/LICENSE", "type": "blob"},
                    ]
                }).encode("utf-8"))
            if "sdk/python/omp-rpc/src/omp_rpc/__init__.py" in url:
                return MockHttpResponse(b"__version__ = '18.6.0'\n")
            if "sdk/python/omp-rpc/src/omp_rpc/client.py" in url:
                return MockHttpResponse(b"class RpcClient:\n    def new_feature(self): pass\n")
            if "sdk/python/omp-rpc/LICENSE" in url:
                return MockHttpResponse(b"LICENSE\n")
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        result = update_runtime.prepare_omp(self.repo_dir, version="18.6.0")
        self.assertEqual(result["version"], "18.6.0")
        self.assertEqual(result["sdk_source_path"], "sdk/python/omp-rpc")

        updated_runtime = json.loads(self.runtime_lock_file.read_text())
        self.assertEqual(updated_runtime["versions"]["omp"], "18.6.0")
        self.assertEqual(updated_runtime["runtimeInputs"]["omp"]["sha256"], binary_sha)
        updated_rpc = json.loads(self.omp_rpc_lock_file.read_text())
        self.assertEqual(updated_rpc["version"], "18.6.0")
        self.assertEqual(updated_rpc["commit"], "89d2610993af69427574bde17791df63906ec4e5")
        self.assertEqual(updated_rpc["sourcePath"], "sdk/python/omp-rpc")


class TestPrepareHermes(BaseRuntimeUpdaterTest):
    """Behavioral tests for 'prepare hermes' candidate preparation."""

    @patch("urllib.request.urlopen")
    def test_prepare_hermes_by_commit_sha(self, mock_urlopen: MagicMock) -> None:
        """Hermes prepare with direct 40-char commit SHA and dependency diff."""
        target_commit = "6666666666666666666666666666666666666666"
        tar_bytes = make_tar_bytes({
            "hermes-agent/pyproject.toml": b"[project]\nname = 'hermes-agent'\ndependencies = ['fastapi>=0.100.0', 'new-pkg>=1.0.0'] # valid inline TOML\n",
            "hermes-agent/setup.py": b"# setup.py\n",
        })
        tar_sha = hashlib.sha256(tar_bytes).hexdigest()

        old_pyproject = b"[project]\nname = 'hermes-agent'\ndependencies = [\n    'fastapi>=0.100.0',\n]\n"
        old_archive = make_tar_bytes({
            "hermes-agent/pyproject.toml": old_pyproject,
            "hermes-agent/requirements-legacy.txt": b"old-extra==1.0\n",
        })
        self.initial_runtime_lock["hermes"]["sourceSha256"] = hashlib.sha256(old_archive).hexdigest()
        self.runtime_lock_file.write_text(json.dumps(self.initial_runtime_lock) + "\n")

        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if f"commits/{target_commit}" in url:
                return MockHttpResponse(json.dumps({"sha": target_commit}).encode("utf-8"))
            if f"tar.gz/{target_commit}" in url:
                return MockHttpResponse(tar_bytes)
            if "f97608f178d1ffeca59860195ab7da295f7c8e5f/pyproject.toml" in url:
                return MockHttpResponse(old_pyproject)
            if "tar.gz/f97608f178d1ffeca59860195ab7da295f7c8e5f" in url:
                return MockHttpResponse(old_archive)
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        orig_rpc_bytes = self.omp_rpc_lock_file.read_bytes()

        result = update_runtime.prepare_hermes(self.repo_dir, ref=target_commit)

        self.assertEqual(result["status"], "prepared")
        self.assertEqual(result["resolved_commit"], target_commit)
        self.assertEqual(result["archive_sha256"], tar_sha)
        self.assertEqual(result["pyproject_diff"]["added_dependencies"], ["new-pkg>=1.0.0"])
        self.assertEqual(result["dependency_inventory"]["removed_files"], ["requirements-legacy.txt"])
        self.assertTrue(result["omp_rpc_lock_untouched"])

        updated = json.loads(self.runtime_lock_file.read_text())
        self.assertEqual(updated["versions"]["hermesSource"], target_commit)
        self.assertEqual(updated["hermes"]["sourceSha256"], tar_sha)
        self.assertEqual(self.omp_rpc_lock_file.read_bytes(), orig_rpc_bytes)

    @patch("urllib.request.urlopen")
    def test_prepare_hermes_strict_ref_rejects_branch(self, mock_urlopen: MagicMock) -> None:
        """Branch names must be rejected in prepare_hermes mode."""
        orig_runtime_bytes = self.runtime_lock_file.read_bytes()
        mock_urlopen.side_effect = urllib.error.HTTPError("https://api.github.com/...", 404, "Not Found", {}, io.BytesIO(b""))

        with self.assertRaises(update_runtime.UpstreamNotFoundError):
            update_runtime.prepare_hermes(self.repo_dir, ref="main")

        self.assertEqual(self.runtime_lock_file.read_bytes(), orig_runtime_bytes)

    @patch("urllib.request.urlopen")
    def test_prepare_hermes_concurrency_guard_checks_untouched_sdk_lock(self, mock_urlopen: MagicMock) -> None:
        """If untouched omp-rpc-lock.json is modified during hermes prepare, abort."""
        target_commit = "7777777777777777777777777777777777777777"
        tar_bytes = make_tar_bytes({"hermes/pyproject.toml": b""})
        self.initial_runtime_lock["hermes"]["sourceSha256"] = hashlib.sha256(tar_bytes).hexdigest()
        self.runtime_lock_file.write_text(json.dumps(self.initial_runtime_lock) + "\n")

        def fake_urlopen(req, timeout=60):
            url = req.full_url if hasattr(req, "full_url") else req
            if f"commits/{target_commit}" in url:
                return MockHttpResponse(json.dumps({"sha": target_commit}).encode("utf-8"))
            if f"tar.gz/{target_commit}" in url:
                # Mutate untouched SDK lock file mid-flight
                self.omp_rpc_lock_file.write_text('{"tampered": true}\n')
                return MockHttpResponse(tar_bytes)
            if "tar.gz/f97608f178d1ffeca59860195ab7da295f7c8e5f" in url:
                return MockHttpResponse(tar_bytes)
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

        mock_urlopen.side_effect = fake_urlopen

        with self.assertRaises(update_runtime.ConcurrentModificationError):
            update_runtime.prepare_hermes(self.repo_dir, ref=target_commit)


class TestAtomicRollbackAndAuth(BaseRuntimeUpdaterTest):
    """Behavioral tests for atomic staged replacements, rollback, and exact auth host filtering."""

    def test_sdk_api_includes_inherited_methods_but_not_unrelated_helpers(self):
        signatures = update_runtime.extract_method_signatures({
            "client.py": b"from ._wire import WireClient\nclass RpcClient(WireClient):\n    def prompt(self, message: str): pass\n",
            "_wire.py": b"class WireClient:\n    def get_state(self): pass\nclass Helper:\n    def normalize(self): pass\n",
        })
        self.assertEqual(set(signatures), {"prompt", "get_state"})

    def test_verify_and_save_atomic_rollback_on_replacement_failure(self) -> None:
        """Sequential replacement error triggers rollback of previously replaced files."""
        file1 = self.deploy_dir / "file1.json"
        file2 = self.deploy_dir / "file2.json"
        file1.write_text("orig1\n")
        file2.write_text("orig2\n")

        orig_snaps = {file1: b"orig1\n", file2: b"orig2\n"}
        staged = {file1: "new1\n", file2: "new2\n"}

        real_replace = os.replace
        call_count = 0

        def failing_replace(src, dst):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise OSError("Simulated second rename failure")
            real_replace(src, dst)

        with patch("os.replace", side_effect=failing_replace):
            with self.assertRaises(update_runtime.UpdateError):
                update_runtime.verify_and_save_atomic(orig_snaps, staged)

        # file1 must be rolled back to orig1\n
        self.assertEqual(file1.read_text(), "orig1\n")
        self.assertEqual(file2.read_text(), "orig2\n")
    def test_verify_and_save_atomic_rollback_failure_preserves_recovery_file(self) -> None:
        """When rollback restoration also fails, recovery snapshot file is preserved on disk."""
        file1 = self.deploy_dir / "file1.json"
        file2 = self.deploy_dir / "file2.json"
        file1.write_text("orig1\n")
        file2.write_text("orig2\n")

        orig_snaps = {file1: b"orig1\n", file2: b"orig2\n"}
        staged = {file1: "new1\n", file2: "new2\n"}

        real_replace = os.replace
        call_count = 0

        def failing_replace_all(src, dst):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise OSError("Simulated replacement and rollback failure")
            real_replace(src, dst)

        with patch("os.replace", side_effect=failing_replace_all):
            with self.assertRaises(update_runtime.UpdateError) as cm:
                update_runtime.verify_and_save_atomic(orig_snaps, staged)

        self.assertIn("CRITICAL", str(cm.exception))
        recovery_files = list(self.deploy_dir.glob("file1.json.recovery.*"))
        self.assertTrue(len(recovery_files) >= 1)
        self.assertEqual(recovery_files[0].read_bytes(), b"orig1\n")

    def test_make_request_auth_token_exact_host_only(self) -> None:
        """Authorization header attached only for exact HTTPS api.github.com."""
        with patch.dict(os.environ, {"GITHUB_TOKEN": "secret_token_123"}):
            # 1. Exact API endpoint
            req1 = update_runtime.make_request("https://api.github.com/repos/test/test", is_api=True)
            self.assertEqual(req1.headers.get("Authorization"), "Bearer secret_token_123")

            # 2. Raw content endpoint (must not receive auth token)
            req2 = update_runtime.make_request("https://raw.githubusercontent.com/test/test", is_api=False)
            self.assertNotIn("Authorization", req2.headers)

            # 3. Substring URL (e.g. evil-api.github.com or http://api.github.com)
            req3 = update_runtime.make_request("https://not-api.github.com/api.github.com", is_api=True)
            self.assertNotIn("Authorization", req3.headers)

            req4 = update_runtime.make_request("http://api.github.com/insecure", is_api=True)
            self.assertNotIn("Authorization", req4.headers)


class TestCliAndIsolation(BaseRuntimeUpdaterTest):
    """Behavioral tests for CLI arguments, exit codes, and repository isolation."""

    @patch("urllib.request.urlopen")
    def test_repo_flag_isolation(self, mock_urlopen: MagicMock) -> None:
        """The --repo flag must isolate updates to the given directory without altering the caller repo."""
        isolated_dir = tempfile.mkdtemp(prefix="isolated_candidate_")
        try:
            iso_repo = Path(isolated_dir) / "subrepo"
            iso_deploy = iso_repo / "deploy"
            iso_hermes = iso_deploy / "hermes"
            iso_hermes.mkdir(parents=True)

            (iso_deploy / "runtime-lock.json").write_text(self.runtime_lock_file.read_text())
            (iso_hermes / "omp-rpc-lock.json").write_text(self.omp_rpc_lock_file.read_text())

            target_commit = "9999999999999999999999999999999999999999"
            tar_bytes = make_tar_bytes({"hermes/pyproject.toml": b""})
            isolated_lock = json.loads((iso_deploy / "runtime-lock.json").read_text())
            isolated_lock["hermes"]["sourceSha256"] = hashlib.sha256(tar_bytes).hexdigest()
            (iso_deploy / "runtime-lock.json").write_text(json.dumps(isolated_lock) + "\n")

            def fake_urlopen(req, timeout=60):
                url = req.full_url if hasattr(req, "full_url") else req
                if f"commits/{target_commit}" in url:
                    return MockHttpResponse(json.dumps({"sha": target_commit}).encode("utf-8"))
                if f"tar.gz/{target_commit}" in url:
                    return MockHttpResponse(tar_bytes)
                if f"tar.gz/{self.initial_runtime_lock['versions']['hermesSource']}" in url:
                    return MockHttpResponse(tar_bytes)
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))

            mock_urlopen.side_effect = fake_urlopen

            orig_self_runtime = self.runtime_lock_file.read_bytes()

            code = update_runtime.main(["prepare", "hermes", "--ref", target_commit, "--repo", str(iso_repo)])
            self.assertEqual(code, 0)

            iso_updated = json.loads((iso_deploy / "runtime-lock.json").read_text())
            self.assertEqual(iso_updated["versions"]["hermesSource"], target_commit)
            self.assertEqual(self.runtime_lock_file.read_bytes(), orig_self_runtime)
        finally:
            shutil.rmtree(isolated_dir, ignore_errors=True)

    def test_cli_missing_required_args(self) -> None:
        """Missing required --version or --ref causes argparse to exit with code 2."""
        with self.assertRaises(SystemExit) as cm:
            update_runtime.main(["prepare", "omp"])
        self.assertEqual(cm.exception.code, 2)

        with self.assertRaises(SystemExit) as cm:
            update_runtime.main(["prepare", "hermes"])
        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
