"""Fetch only the immutable, checksum-pinned standard-library Python RPC client."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
from urllib.request import urlopen
from urllib.parse import quote


def relative_path(value: str) -> str:
    path = PurePosixPath(value)
    if not path.parts or path.is_absolute() or ".." in path.parts or str(path) != value:
        raise ValueError(f"Invalid SDK relative path: {value!r}")
    return value


def fetch(lock_path: Path, destination: Path) -> None:
    lock = json.loads(lock_path.read_text())
    source = relative_path(lock["sourcePath"])
    base = f"https://raw.githubusercontent.com/can1357/oh-my-pi/{lock['commit']}/{quote(source, safe='/')}"
    inputs = [(f"src/omp_rpc/{relative_path(name)}", digest) for name, digest in lock["files"].items()]
    inputs.append(("LICENSE", lock["licenseSha256"]))
    for name, expected in inputs:
        with urlopen(f"{base}/{quote(name, safe='/')}", timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError(f"OMP RPC checksum mismatch: {name}")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


if __name__ == "__main__":
    fetch(Path(sys.argv[1]), Path(sys.argv[2]))
