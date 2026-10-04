"""Initialize a dedicated direct-executor state root; never adopt bridge state."""
import os
from pathlib import Path
import secrets


def initialize(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("state root must be an existing real directory")
    marker = root / ".omp-direct-executor"
    if not marker.exists() and any(root.iterdir()):
        raise RuntimeError("refusing nonempty state without a direct-executor marker")
    owner = root.stat()
    marker.touch(mode=0o600, exist_ok=True)
    directories = {
        "secrets": (owner.st_uid, owner.st_gid, 0o700),
        "executor": (1001, 1001, 0o700),
        "executor/workspaces": (1001, 1001, 0o700),
        "executor/artifacts": (1001, 1001, 0o755),
        "omp-state": (1001, 1001, 0o700),
        "assets": (1001, 1001, 0o755),
        "font-cache": (1001, 1001, 0o755),
        "hermes": (10000, 10000, 0o700),
        "hermes/plugins": (10000, 10000, 0o700),
        "hermes/skills": (10000, 10000, 0o700),
    }
    for name, (uid, gid, mode) in directories.items():
        path = root / name
        if path.is_symlink():
            raise RuntimeError(f"state directory must not be a symlink: {name}")
        path.mkdir(mode=mode, exist_ok=True)
        os.chown(path, uid, gid)
        path.chmod(mode)
    seeds = {
        "secrets/executor-token": (secrets.token_hex(32) + "\n", owner.st_uid, owner.st_gid, 0o644),
        "hermes/config.yaml": (
            "plugins:\n  enabled: [omp-executor]\nterminal:\n  backend: local\n  cwd: /opt/data/workspace\n",
            10000, 10000, 0o600,
        ),
    }
    for name, (content, uid, gid, mode) in seeds.items():
        path = root / name
        if path.is_symlink():
            raise RuntimeError(f"state file must not be a symlink: {name}")
        if not path.exists():
            with path.open("x") as target:
                target.write(content)
            os.chown(path, uid, gid)
            path.chmod(mode)
    print("Direct executor state initialized; existing configuration and token preserved.")


if __name__ == "__main__":
    initialize(Path("/state"))
