"""Consumer-visible runtime pin consistency and media cache boundaries."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "deploy" / "runtime-pins.py"


class RuntimePinsTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="runtime-pins-test-")
        self.addCleanup(self.work.cleanup)
        self.repo = Path(self.work.name)
        (self.repo / "deploy" / "hermes").mkdir(parents=True)
        for name in (
            "package.json", "deploy/runtime-lock.json",
            "deploy/hermes/omp-rpc-lock.json", "deploy/media-runtime-lock.json",
        ):
            (self.repo / name).write_bytes((ROOT / name).read_bytes())

    def command(self, *args):
        return subprocess.run(
            [sys.executable, str(HELPER), "--repo", str(self.repo), *args],
            capture_output=True, text=True, timeout=10,
        )

    def metadata(self):
        result = self.command("--format", "json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def change(self, name, mutate):
        path = self.repo / name
        value = json.loads(path.read_text())
        mutate(value)
        path.write_text(json.dumps(value, indent=2) + "\n")

    def test_mismatched_binary_and_sdk_version_fails_without_mutation(self):
        self.change("deploy/hermes/omp-rpc-lock.json", lambda lock: lock.update(version="99.0.0"))
        before = {str(path): path.read_bytes() for path in self.repo.rglob("*.json")}
        result = self.command("--format", "env")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.repo.rglob("*.json")})

    def test_missing_package_cannot_produce_a_fallback_service_tag(self):
        (self.repo / "package.json").unlink()
        result = self.command("--format", "json")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_missing_sdk_cannot_skip_coupled_validation(self):
        (self.repo / "deploy/hermes/omp-rpc-lock.json").unlink()
        result = self.command("--format", "json")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_explicit_missing_candidate_does_not_fall_back_to_parent_checkout(self):
        child = self.repo / "candidate"
        child.mkdir()
        before = (self.repo / "deploy/media-runtime-lock.json").read_bytes()
        result = subprocess.run(
            [sys.executable, str(HELPER), "--repo", str(child), "--sync-media-lock"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.repo / "deploy/media-runtime-lock.json").read_bytes(), before)

    def test_omp_and_hermes_only_updates_keep_media_identity(self):
        before = self.metadata()["WORKER_RUNTIME_IMAGE"]
        media_bytes = (self.repo / "deploy/media-runtime-lock.json").read_bytes()
        self.change("deploy/runtime-lock.json", lambda lock: lock["versions"].update(omp="99.0.0"))
        self.change("deploy/runtime-lock.json", lambda lock: lock["runtimeInputs"]["omp"].update(
            url="https://github.com/can1357/oh-my-pi/releases/download/v99.0.0/omp-linux-x64"))
        self.change("deploy/hermes/omp-rpc-lock.json", lambda lock: lock.update(version="99.0.0"))
        commit = "a" * 40
        self.change("deploy/runtime-lock.json", lambda lock: lock["versions"].update(hermesSource=commit))
        self.change("deploy/runtime-lock.json", lambda lock: lock["hermes"].update(
            sourceUrl=f"https://codeload.github.com/NousResearch/hermes-agent/tar.gz/{commit}"))
        self.assertEqual(self.metadata()["WORKER_RUNTIME_IMAGE"], before)
        self.assertEqual((self.repo / "deploy/media-runtime-lock.json").read_bytes(), media_bytes)

    def test_stale_media_lock_blocks_build_until_explicit_sync(self):
        before = self.metadata()["WORKER_RUNTIME_IMAGE"]
        self.change("deploy/runtime-lock.json", lambda lock: lock["runtimeInputs"]["skills"].update(sha256="a" * 64))
        stale = self.command("--format", "json")
        self.assertNotEqual(stale.returncode, 0)
        self.assertEqual(stale.stdout, "")
        sync = self.command("--sync-media-lock", "--format", "json")
        self.assertEqual(sync.returncode, 0, sync.stderr)
        self.assertNotEqual(self.metadata()["WORKER_RUNTIME_IMAGE"], before)

    def test_unsafe_export_values_are_rejected_not_evaluated(self):
        self.change("deploy/runtime-lock.json", lambda lock: lock["versions"].update(node="22.20.0;touch /tmp/injected"))
        media_before = (self.repo / "deploy/media-runtime-lock.json").read_bytes()
        result = self.command("--sync-media-lock", "--format", "env")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual((self.repo / "deploy/media-runtime-lock.json").read_bytes(), media_before)


if __name__ == "__main__":
    unittest.main()
