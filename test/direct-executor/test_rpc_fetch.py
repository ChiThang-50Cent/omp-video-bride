"""Reject SDK lock paths that could escape the isolated installation tree."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "deploy/hermes/fetch-omp-rpc.py"
SPEC = importlib.util.spec_from_file_location("rpc_fetch", SCRIPT)
FETCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FETCHER)


class RpcFetchTests(unittest.TestCase):
    def test_traversal_is_rejected_before_network_or_destination_mutation(self):
        with tempfile.TemporaryDirectory(prefix="sdk-path-test-") as work:
            root = Path(work)
            destination = root / "sdk"
            destination.mkdir()
            protected = root / "protected.py"
            protected.write_bytes(b"original module")
            for field in ("sourcePath", "files"):
                with self.subTest(field=field):
                    lock = {
                        "commit": "a" * 40,
                        "sourcePath": "sdk/python/omp-rpc",
                        "files": {"client.py": "b" * 64},
                        "licenseSha256": "c" * 64,
                    }
                    if field == "sourcePath":
                        lock[field] = "../omp-rpc"
                    else:
                        lock[field] = {"../../../protected.py": "b" * 64}
                    manifest = root / "lock.json"
                    manifest.write_text(json.dumps(lock))
                    with patch.object(FETCHER, "urlopen") as network:
                        with self.assertRaises(ValueError):
                            FETCHER.fetch(manifest, destination)
                        network.assert_not_called()
                    self.assertEqual(protected.read_bytes(), b"original module")
                    self.assertEqual(list(destination.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
