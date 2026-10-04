#!/usr/bin/env python3
"""Authoritative build metadata and runtime pins helper.

Derives build arguments, image tags, and environment variables from
deploy/runtime-lock.json, deploy/hermes/omp-rpc-lock.json, and package.json.
Validates coupled SDK pins and generates/verifies deploy/media-runtime-lock.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

SAFE_KEY_RE = re.compile(r"^[A-Z0-9_]+$")
SAFE_VALUE_RE = re.compile(r"^[a-zA-Z0-9_.:@/-]+$")


def validate_pin_safety(pins: Dict[str, str]) -> None:
    """Ensure no shell metacharacters, control characters, or whitespace in pins."""
    for k, v in pins.items():
        if not SAFE_KEY_RE.match(k):
            raise ValueError(f"Unsafe pin key '{k}': contains invalid characters")
        if not SAFE_VALUE_RE.match(v):
            raise ValueError(f"Unsafe pin value for '{k}': {v!r} contains shell metacharacters or whitespace")

def find_repo_root(start: Optional[Path | str] = None) -> Path:
    """Locate repository root, resolving explicit start path or walking upwards."""
    if start is not None:
        p = Path(start).resolve()
        if p.is_file():
            p = p.parent
        return p
    current = Path(__file__).resolve().parent
    for candidate in [current, *current.parents]:
        if (candidate / "deploy" / "runtime-lock.json").is_file():
            return candidate
    return Path(__file__).resolve().parents[1]

def sqlite_autoconf_version(sqlite_ver: str) -> str:
    """Format semantic version (e.g. 3.53.4) to autoconf number (3530400)."""
    parts = sqlite_ver.split(".")
    major = parts[0]
    minor = parts[1].zfill(2) if len(parts) > 1 else "00"
    patch = parts[2].zfill(2) if len(parts) > 2 else "00"
    return f"{major}{minor}{patch}00"


def canonical_media_lock(root_lock: Dict[str, Any]) -> Tuple[Dict[str, Any], bytes, str]:
    """Derive canonical media-only lock excluding OMP and Hermes pins."""
    media = {
        "platform": root_lock["platform"],
        "versions": {k: v for k, v in sorted(root_lock["versions"].items()) if k not in ("omp", "hermesSource")},
        "runtimeInputs": {k: v for k, v in sorted(root_lock["runtimeInputs"].items()) if k != "omp"},
        "assets": root_lock["assets"],
        "notes": root_lock.get("notes", []),
    }
    canonical_bytes = (json.dumps(media, indent=2, sort_keys=True) + "\n").encode("utf-8")
    sha256 = hashlib.sha256(canonical_bytes).hexdigest()
    return media, canonical_bytes, sha256


def validate_locks(
    repo: Optional[Path] = None,
    check_media: bool = True,
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """Validate root lock, coupled SDK lock, package.json, and optional media lock."""
    root = repo or find_repo_root()
    root_lock_path = root / "deploy" / "runtime-lock.json"
    sdk_lock_path = root / "deploy" / "hermes" / "omp-rpc-lock.json"
    pkg_path = root / "package.json"
    media_lock_path = root / "deploy" / "media-runtime-lock.json"

    if not root_lock_path.is_file():
        raise FileNotFoundError(f"Missing root lock: {root_lock_path}")
    if not sdk_lock_path.is_file():
        raise FileNotFoundError(f"Missing hermes SDK lock: {sdk_lock_path}")
    if not pkg_path.is_file():
        raise FileNotFoundError(f"Missing package.json: {pkg_path}")

    root_lock = json.loads(root_lock_path.read_text(encoding="utf-8"))
    sdk_lock = json.loads(sdk_lock_path.read_text(encoding="utf-8"))
    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    if not pkg.get("version"):
        raise ValueError(f"package.json at {pkg_path} missing required 'version' field")

    omp_ver = root_lock.get("versions", {}).get("omp")
    sdk_ver = sdk_lock.get("version")
    if not omp_ver:
        raise ValueError("deploy/runtime-lock.json missing versions.omp")
    if not sdk_ver:
        raise ValueError("deploy/hermes/omp-rpc-lock.json missing version")
    if omp_ver != sdk_ver:
        raise ValueError(
            f"OMP runtime / SDK version mismatch: runtime-lock has '{omp_ver}' but omp-rpc-lock has '{sdk_ver}'"
        )

    if "omp" not in root_lock.get("runtimeInputs", {}):
        raise ValueError("deploy/runtime-lock.json missing runtimeInputs.omp")
    if "hermes" not in root_lock:
        raise ValueError("deploy/runtime-lock.json missing hermes section")

    if check_media:
        if not media_lock_path.is_file():
            raise FileNotFoundError(
                f"Missing deploy/media-runtime-lock.json: {media_lock_path}. "
                "Run 'python3 deploy/runtime-pins.py --sync-media-lock' to generate it."
            )
        _, canonical_bytes, _ = canonical_media_lock(root_lock)
        actual_bytes = media_lock_path.read_bytes()
        if actual_bytes != canonical_bytes:
            raise ValueError(
                "deploy/media-runtime-lock.json is out of date with deploy/runtime-lock.json. "
                "Run 'python3 deploy/runtime-pins.py --sync-media-lock' to refresh it."
            )

    return root_lock, sdk_lock, pkg


def sync_media_lock(repo: Optional[Path] = None) -> Path:
    """Write canonical deploy/media-runtime-lock.json after validating metadata."""
    root = repo or find_repo_root()
    pins = get_pins(repo=root, sync_media=False, skip_media_validation=True)
    validate_pin_safety(pins)

    root_lock_path = root / "deploy" / "runtime-lock.json"
    root_lock = json.loads(root_lock_path.read_text(encoding="utf-8"))
    _, canonical_bytes, _ = canonical_media_lock(root_lock)

    media_lock_path = root / "deploy" / "media-runtime-lock.json"
    media_lock_path.write_bytes(canonical_bytes)
    return media_lock_path
def get_pins(
    repo: Optional[Path] = None,
    registry: Optional[str] = None,
    sync_media: bool = False,
    skip_media_validation: bool = False,
) -> Dict[str, str]:
    """Extract and derive all build metadata and authoritative pins."""
    root = repo or find_repo_root()
    check_media = (not sync_media and not skip_media_validation)
    root_lock, sdk_lock, package_info = validate_locks(root, check_media=check_media)

    _, _, media_sha = canonical_media_lock(root_lock)
    if sync_media:
        sync_media_lock(root)
    omp_ver = root_lock["versions"]["omp"]
    package_ver = package_info["version"]
    omp_spec = root_lock["runtimeInputs"]["omp"]
    omp_url = omp_spec["url"]
    omp_sha = omp_spec["sha256"]

    node_ver = root_lock["versions"]["node"]
    hyperframes_ver = root_lock["versions"]["hyperframes"]
    hermes_commit = root_lock["versions"]["hermesSource"]
    hermes_sha = root_lock["hermes"]["sourceSha256"]
    sqlite_ver = root_lock["hermes"]["sqliteVersion"]
    sqlite_autoconf = sqlite_autoconf_version(sqlite_ver)
    sqlite_sha = root_lock["hermes"]["sqliteSha256"]
    media_short = media_sha[:12]
    worker_runtime_tag = f"node{node_ver}-hf{hyperframes_ver}-cpu-{media_short}"
    hermes_base_tag = f"{hermes_commit}-telegram"
    omp_executor_tag = package_ver
    hermes_executor_tag = package_ver

    reg_prefix = f"{registry.rstrip('/')}/" if registry else ""

    worker_runtime_image = f"{reg_prefix}omp-media-runtime:{worker_runtime_tag}"
    hermes_base_image = f"{reg_prefix}omp-hermes-runtime:{hermes_base_tag}"
    omp_executor_image = f"{reg_prefix}omp-direct-executor:{omp_executor_tag}"
    hermes_executor_image = f"{reg_prefix}omp-hermes-executor:{hermes_executor_tag}"

    pins = {
        "OMP_VERSION": omp_ver,
        "OMP_ARCHIVE_SHA256": omp_sha,
        "OMP_URL": omp_url,
        "HERMES_COMMIT": hermes_commit,
        "HERMES_ARCHIVE_SHA256": hermes_sha,
        "SQLITE_VERSION": sqlite_ver,
        "SQLITE_AUTOCONF_VERSION": sqlite_autoconf,
        "SQLITE_SHA256": sqlite_sha,
        "NODE_VERSION": node_ver,
        "HYPERFRAMES_VERSION": hyperframes_ver,
        "PACKAGE_VERSION": package_ver,
        "MEDIA_LOCK_SHA256": media_sha,
        "MEDIA_LOCK_DIGEST_SHORT": media_short,
        "WORKER_RUNTIME_IMAGE_BASE": "omp-media-runtime",
        "WORKER_RUNTIME_TAG": worker_runtime_tag,
        "WORKER_RUNTIME_IMAGE": worker_runtime_image,
        "HERMES_BASE_IMAGE_BASE": "omp-hermes-runtime",
        "HERMES_BASE_TAG": hermes_base_tag,
        "HERMES_BASE_IMAGE": hermes_base_image,
        "OMP_EXECUTOR_IMAGE_BASE": "omp-direct-executor",
        "OMP_EXECUTOR_TAG": omp_executor_tag,
        "OMP_EXECUTOR_IMAGE": omp_executor_image,
        "HERMES_EXECUTOR_IMAGE_BASE": "omp-hermes-executor",
        "HERMES_EXECUTOR_TAG": hermes_executor_tag,
        "HERMES_EXECUTOR_IMAGE": hermes_executor_image,
    }
    validate_pin_safety(pins)
    return pins


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--format",
        choices=["env", "json"],
        default="env",
        help="Output format: 'env' (standard KEY=VALUE) or 'json'",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=None,
        help="Path to repository root (defaults to auto-detection)",
    )
    parser.add_argument(
        "--registry",
        type=str,
        default=None,
        help="Optional image registry prefix (e.g. ghcr.io/owner)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate lock files and exit without printing pins",
    )
    parser.add_argument(
        "--sync-media-lock",
        action="store_true",
        help="Synchronize deploy/media-runtime-lock.json from root lock",
    )

    args = parser.parse_args()
    repo = find_repo_root(args.repo)

    if args.sync_media_lock:
        path = sync_media_lock(repo)
        print(f"Synchronized {path}")
        return

    if args.check:
        validate_locks(repo)
        print("All runtime locks and pins are consistent.")
        return

    pins = get_pins(repo=repo, registry=args.registry, sync_media=False)

    if args.format == "json":
        print(json.dumps(pins, indent=2, sort_keys=True))
    else:
        for k, v in pins.items():
            print(f"{k}={v}")


if __name__ == "__main__":
    main()
