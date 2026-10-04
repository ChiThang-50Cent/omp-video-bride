#!/usr/bin/env python3
"""Unified OMP and Hermes runtime updater.

Checks upstream releases and prepares immutable candidate lock files
for OMP and Hermes without modifying unrelated runtime pins or silently
migrating native plugin command allowlists.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tomllib
from typing import Any, Dict, List, Optional, Set, Tuple
import urllib.error
import urllib.parse
import urllib.request

OMP_REPO = "can1357/oh-my-pi"
HERMES_REPO = "NousResearch/hermes-agent"
DEFAULT_TIMEOUT = 60
USER_AGENT = "omp-runtime-updater/1.0"


class UpdateError(Exception):
    """Base exception for runtime updater errors."""


class CoupledLockMismatchError(UpdateError):
    """Raised when runtime-lock.json and omp-rpc-lock.json versions do not match or are missing."""


class UpstreamNotFoundError(UpdateError):
    """Raised when an upstream release, tag, or commit cannot be found."""


class DigestMismatchError(UpdateError):
    """Raised when downloaded asset checksum does not match publisher digest."""


class ConcurrentModificationError(UpdateError):
    """Raised when lock files on disk change while update is in progress."""


class NetworkError(UpdateError):
    """Raised on network or download failures."""


def make_request(url: str, is_api: bool = True, timeout: int = DEFAULT_TIMEOUT) -> urllib.request.Request:
    """Construct an HTTP request, attaching auth only for exact HTTPS api.github.com host."""
    headers = {"User-Agent": USER_AGENT}
    parsed = urllib.parse.urlparse(url)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if is_api and token and parsed.scheme == "https" and parsed.netloc == "api.github.com":
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def http_get_bytes(url: str, is_api: bool = True, timeout: int = DEFAULT_TIMEOUT) -> bytes:
    """Fetch raw bytes from a URL with timeout and clear error reporting."""
    req = make_request(url, is_api=is_api, timeout=timeout)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise UpstreamNotFoundError(f"Resource not found (HTTP 404): {url}") from e
        raise NetworkError(f"HTTP error {e.code} fetching {url}: {e.reason}") from e
    except urllib.error.URLError as e:
        raise NetworkError(f"Network error fetching {url}: {e.reason}") from e


def http_get_json(url: str, is_api: bool = True, timeout: int = DEFAULT_TIMEOUT) -> Any:
    """Fetch and parse JSON from a URL."""
    data = http_get_bytes(url, is_api=is_api, timeout=timeout)
    try:
        return json.loads(data.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise UpdateError(f"Failed to parse JSON response from {url}: {e}") from e


@contextlib.contextmanager
def repo_flock(repo_dir: Path):
    """Acquire a non-blocking advisory flock on the repository directory FD.

    Serializes concurrent updater invocations on the same repository checkout
    without creating persistent extra lock files.
    """
    fd = -1
    try:
        try:
            fd = os.open(str(repo_dir), os.O_RDONLY)
        except OSError:
            pass
        if fd >= 0:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (BlockingIOError, OSError) as e:
                raise ConcurrentModificationError(
                    f"Another prepare process is currently operating on repository '{repo_dir}'"
                ) from e
        yield
    finally:
        if fd >= 0:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass


def peel_git_object(owner_repo: str, obj: dict, timeout: int = DEFAULT_TIMEOUT, depth: int = 0) -> str:
    """Recursively dereference annotated tags to their target commit SHA."""
    if depth > 10:
        raise UpdateError("Exceeded maximum recursion depth while peeling git object")
    obj_type = obj.get("type")
    sha = obj.get("sha")
    if not sha or not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        raise UpdateError(f"Malformed or missing git object SHA '{sha}' in {owner_repo}")
    if obj_type == "commit":
        return sha.lower()
    if obj_type == "tag":
        url = obj.get("url") or f"https://api.github.com/repos/{owner_repo}/git/tags/{sha}"
        tag_data = http_get_json(url, is_api=True, timeout=timeout)
        target_obj = tag_data.get("object", {})
        return peel_git_object(owner_repo, target_obj, timeout=timeout, depth=depth + 1)
    raise UpdateError(f"Unexpected git object type '{obj_type}' for sha {sha}")


def resolve_git_commit(
    owner_repo: str,
    ref_or_tag: str,
    timeout: int = DEFAULT_TIMEOUT,
    allow_branch: bool = False,
) -> str:
    """Strictly resolve a ref, tag, or 40-char SHA to an immutable commit SHA."""
    if re.fullmatch(r"[0-9a-fA-F]{40}", ref_or_tag):
        url = f"https://api.github.com/repos/{owner_repo}/commits/{ref_or_tag}"
        commit_data = http_get_json(url, is_api=True, timeout=timeout)
        sha = commit_data.get("sha")
        if not sha or sha.lower() != ref_or_tag.lower():
            raise UpdateError(f"GitHub API commit verification failed: requested '{ref_or_tag}' but API returned '{sha}'")
        return sha.lower()

    possible_tags = [ref_or_tag]
    if ref_or_tag.startswith("v"):
        possible_tags.append(ref_or_tag[1:])
    else:
        possible_tags.append(f"v{ref_or_tag}")

    for t in possible_tags:
        url = f"https://api.github.com/repos/{owner_repo}/git/ref/tags/{urllib.parse.quote(t)}"
        try:
            ref_data = http_get_json(url, is_api=True, timeout=timeout)
            return peel_git_object(owner_repo, ref_data.get("object", {}), timeout=timeout)
        except UpstreamNotFoundError:
            continue

    if allow_branch:
        url_branch = f"https://api.github.com/repos/{owner_repo}/git/ref/heads/{urllib.parse.quote(ref_or_tag)}"
        try:
            ref_data = http_get_json(url_branch, is_api=True, timeout=timeout)
            return peel_git_object(owner_repo, ref_data.get("object", {}), timeout=timeout)
        except UpstreamNotFoundError:
            pass

    raise UpstreamNotFoundError(
        f"Strict ref resolution failed: '{ref_or_tag}' is neither a valid 40-character commit SHA "
        f"nor a published tag in {owner_repo}"
    )


def load_lock_files(repo_dir: Path) -> Tuple[dict, bytes, dict, bytes]:
    """Load and strictly validate required nonempty fields in both lock files."""
    runtime_lock_path = repo_dir / "deploy" / "runtime-lock.json"
    omp_rpc_lock_path = repo_dir / "deploy" / "hermes" / "omp-rpc-lock.json"

    if not runtime_lock_path.exists():
        raise UpdateError(f"Root lock file missing: {runtime_lock_path}")
    if not omp_rpc_lock_path.exists():
        raise UpdateError(f"OMP RPC lock file missing: {omp_rpc_lock_path}")

    runtime_bytes = runtime_lock_path.read_bytes()
    omp_rpc_bytes = omp_rpc_lock_path.read_bytes()

    try:
        runtime_lock = json.loads(runtime_bytes.decode("utf-8"))
        omp_rpc_lock = json.loads(omp_rpc_bytes.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise UpdateError(f"Failed to parse lock JSON: {e}") from e

    # Validate required fields in runtime-lock.json
    omp_ver = runtime_lock.get("versions", {}).get("omp")
    hermes_source = runtime_lock.get("versions", {}).get("hermesSource")
    omp_input_url = runtime_lock.get("runtimeInputs", {}).get("omp", {}).get("url")
    omp_input_sha = runtime_lock.get("runtimeInputs", {}).get("omp", {}).get("sha256")
    hermes_url = runtime_lock.get("hermes", {}).get("sourceUrl")
    hermes_sha = runtime_lock.get("hermes", {}).get("sourceSha256")

    for val, name in [
        (omp_ver, "versions.omp"),
        (hermes_source, "versions.hermesSource"),
        (omp_input_url, "runtimeInputs.omp.url"),
        (omp_input_sha, "runtimeInputs.omp.sha256"),
        (hermes_url, "hermes.sourceUrl"),
        (hermes_sha, "hermes.sourceSha256"),
    ]:
        if not val or not isinstance(val, str) or not val.strip():
            raise UpdateError(f"Required field '{name}' in deploy/runtime-lock.json is missing or empty")

    # Validate required fields in deploy/hermes/omp-rpc-lock.json
    rpc_ver = omp_rpc_lock.get("version")
    rpc_commit = omp_rpc_lock.get("commit")
    rpc_source_path = omp_rpc_lock.get("sourcePath")
    rpc_files = omp_rpc_lock.get("files")
    rpc_license = omp_rpc_lock.get("licenseSha256")

    for val, name in [
        (rpc_ver, "version"),
        (rpc_commit, "commit"),
        (rpc_source_path, "sourcePath"),
        (rpc_license, "licenseSha256"),
    ]:
        if not val or not isinstance(val, str) or not val.strip():
            raise UpdateError(f"Required field '{name}' in deploy/hermes/omp-rpc-lock.json is missing or empty")

    if not isinstance(rpc_files, dict) or not rpc_files:
        raise UpdateError("Field 'files' in deploy/hermes/omp-rpc-lock.json must be a nonempty mapping")

    # Coupled lock validation: both versions must be nonempty and strictly match
    if not omp_ver or not rpc_ver or omp_ver != rpc_ver:
        raise CoupledLockMismatchError(
            f"Preexisting coupled locks mismatch: deploy/runtime-lock.json has omp='{omp_ver}' "
            f"but deploy/hermes/omp-rpc-lock.json has version='{rpc_ver}'"
        )

    return runtime_lock, runtime_bytes, omp_rpc_lock, omp_rpc_bytes


def verify_and_save_atomic(
    original_snapshots: Dict[Path, bytes],
    staged_contents: Dict[Path, str],
) -> None:
    """Stage writes, verify snapshots before replacement, and track rollback/recovery.

    Notice on crash atomicity limits: POSIX sequential rename with in-memory rollback
    protects against ordinary runtime filesystem exceptions. Cross-file power-loss
    atomicity is explicitly unsupported; subsequent updater runs validate coupled locks
    to reject partial states.
    """
    staged_tmps: Dict[Path, Path] = {}
    try:
        for path, content in staged_contents.items():
            tmp_path = path.parent / f"{path.name}.tmp.{os.getpid()}"
            staged_tmps[path] = tmp_path
            with open(tmp_path, "wb") as f:
                f.write(content.encode("utf-8"))
                f.flush()
                os.fsync(f.fileno())

        for path, orig_bytes in original_snapshots.items():
            if not path.exists():
                raise ConcurrentModificationError(f"Lock file disappeared from disk: {path}")
            if path.read_bytes() != orig_bytes:
                raise ConcurrentModificationError(
                    f"Lock file '{path.name}' was modified concurrently during candidate preparation; aborting."
                )

        replaced_paths: List[Tuple[Path, bytes]] = []
        try:
            for path, tmp_path in staged_tmps.items():
                orig_bytes = original_snapshots[path]
                os.replace(tmp_path, path)
                replaced_paths.append((path, orig_bytes))
        except Exception as exc:
            failed_rollbacks: List[Tuple[Path, str]] = []
            for path, orig_bytes in reversed(replaced_paths):
                try:
                    rollback_tmp = path.parent / f"{path.name}.rollback.{os.getpid()}"
                    with open(rollback_tmp, "wb") as f:
                        f.write(orig_bytes)
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(rollback_tmp, path)
                except Exception as r_exc:
                    rec_file = path.parent / f"{path.name}.recovery.{os.getpid()}"
                    try:
                        rec_file.write_bytes(orig_bytes)
                        failed_rollbacks.append((path, f"preserved recovery file {rec_file.name}: {r_exc}"))
                    except Exception as rec_exc:
                        failed_rollbacks.append((path, f"could not write recovery file ({rec_exc}): {r_exc}"))

            if failed_rollbacks:
                details = "; ".join(f"{p.name} ({reason})" for p, reason in failed_rollbacks)
                raise UpdateError(
                    f"CRITICAL: Replacement failed ({exc}) and rollback restoration also failed for: {details}"
                ) from exc
            raise UpdateError(f"Replacement failed ({exc}); staged changes were successfully rolled back.") from exc

    finally:
        for tmp_path in staged_tmps.values():
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass


def extract_plugin_supported_commands(repo_dir: Path) -> Set[str]:
    """Extract SUPPORTED_COMMANDS from hermes-plugin/omp-executor/executor.py if present."""
    plugin_path = repo_dir / "hermes-plugin" / "omp-executor" / "executor.py"
    if not plugin_path.exists():
        return set()
    content = plugin_path.read_text(encoding="utf-8")
    match = re.search(r"SUPPORTED_COMMANDS:\s*frozenset\[str\]\s*=\s*frozenset\(\{([^}]+)\}\)", content, re.DOTALL)
    if not match:
        return set()
    commands = set()
    for line in match.group(1).splitlines():
        m = re.search(r'["\']([a-zA-Z0-9_]+)["\']', line.strip())
        if m:
            commands.add(m.group(1))
    return commands


def check_runtime(repo_dir: Path, timeout: int = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    """Read-only check comparing current checkout pins against upstream latest releases."""
    runtime_lock, _, omp_rpc_lock, _ = load_lock_files(repo_dir)

    current_omp = runtime_lock["versions"]["omp"]
    current_hermes_commit = runtime_lock["versions"]["hermesSource"]

    # 1. Check OMP upstream latest release
    omp_release = http_get_json(f"https://api.github.com/repos/{OMP_REPO}/releases/latest", is_api=True, timeout=timeout)
    latest_omp_tag = omp_release.get("tag_name", "")
    latest_omp_ver = latest_omp_tag.lstrip("v")
    omp_published_at = omp_release.get("published_at", "")
    omp_update_available = (current_omp != latest_omp_ver)

    # 2. Check Hermes upstream latest release or fallback
    hermes_is_fallback = False
    latest_hermes_tag: Optional[str] = None
    latest_hermes_commit = ""
    hermes_published_at: Optional[str] = None
    hermes_note: Optional[str] = None

    try:
        hermes_release = http_get_json(f"https://api.github.com/repos/{HERMES_REPO}/releases/latest", is_api=True, timeout=timeout)
        latest_hermes_tag = hermes_release.get("tag_name", "")
        hermes_published_at = hermes_release.get("published_at", "")
        latest_hermes_commit = resolve_git_commit(HERMES_REPO, latest_hermes_tag, timeout=timeout, allow_branch=False)
    except UpstreamNotFoundError:
        hermes_is_fallback = True
        repo_info = http_get_json(f"https://api.github.com/repos/{HERMES_REPO}", is_api=True, timeout=timeout)
        default_branch = repo_info.get("default_branch", "main")
        latest_hermes_commit = resolve_git_commit(HERMES_REPO, default_branch, timeout=timeout, allow_branch=True)
        hermes_note = (
            f"Upstream has no published stable release. Reported ref is latest commit "
            f"on default branch '{default_branch}', not a stable release version."
        )

    hermes_update_available = (current_hermes_commit != latest_hermes_commit)

    return {
        "status": "ok",
        "omp": {
            "current_version": current_omp,
            "latest_version": latest_omp_ver,
            "latest_tag": latest_omp_tag,
            "published_at": omp_published_at,
            "update_available": omp_update_available,
        },
        "hermes": {
            "current_commit": current_hermes_commit,
            "latest_tag": latest_hermes_tag,
            "latest_commit": latest_hermes_commit,
            "published_at": hermes_published_at,
            "is_default_branch_fallback": hermes_is_fallback,
            "note": hermes_note,
            "update_available": hermes_update_available,
        },
        "coupled_locks": {
            "synchronized": True,
            "version": current_omp,
        },
    }


def format_check_text(result: Dict[str, Any]) -> str:
    """Format check result as human-readable text."""
    omp = result["omp"]
    hermes = result["hermes"]
    lines = [
        "============================================================",
        "Runtime Version Check Report (Read-Only)",
        "============================================================",
        "",
        "OMP:",
        f"  Current pin:      {omp['current_version']}",
        f"  Upstream latest:  {omp['latest_version']} (tag: {omp['latest_tag']}, published: {omp['published_at']})",
        f"  Status:           {'UPDATE_AVAILABLE (' + omp['current_version'] + ' -> ' + omp['latest_version'] + ')' if omp['update_available'] else 'UP_TO_DATE'}",
        "",
        "Hermes:",
        f"  Current pin:      {hermes['current_commit']}",
    ]
    if hermes["is_default_branch_fallback"]:
        lines.extend([
            f"  Default branch:   commit {hermes['latest_commit']}",
            f"  Status:           NOTE: {hermes['note']}",
        ])
    else:
        lines.extend([
            f"  Upstream release: {hermes['latest_tag']} (commit: {hermes['latest_commit']})",
            f"  Status:           {'UPDATE_AVAILABLE' if hermes['update_available'] else 'UP_TO_DATE'}",
        ])
    lines.extend([
        "",
        "Coupled Lock Integrity:",
        f"  runtime-lock.json omp: {result['coupled_locks']['version']}",
        f"  omp-rpc-lock.json:     {result['coupled_locks']['version']}",
        "  Status:                SYNCHRONIZED",
        "============================================================",
    ])
    return "\n".join(lines)


def resolve_omp_release(version: str, timeout: int = DEFAULT_TIMEOUT) -> Tuple[str, str, dict]:
    """Resolve user version input to (canonical_version, tag, release_data).

    Strictly requires an exact three-component semver (e.g. '18.4.4' or 'v18.4.4').
    Ambiguous non-three-component inputs (like '18.6') are refused.
    """
    m = re.fullmatch(r"^v?([0-9]+\.[0-9]+\.[0-9]+)$", version.strip())
    if not m:
        raise UpdateError(
            f"Invalid OMP release version '{version}'. Expected exact three-component "
            f"release version (e.g. '18.4.4' or 'v18.4.4')."
        )
    clean_ver = m.group(1)
    tag = f"v{clean_ver}"

    for candidate_tag in [tag, clean_ver]:
        rel_url = f"https://api.github.com/repos/{OMP_REPO}/releases/tags/{candidate_tag}"
        try:
            rel = http_get_json(rel_url, is_api=True, timeout=timeout)
            tag_name = rel.get("tag_name")
            if not tag_name or not isinstance(tag_name, str):
                raise UpdateError(f"GitHub release for {candidate_tag} missing valid 'tag_name' field")
            if tag_name.lstrip("v") != clean_ver:
                raise UpdateError(
                    f"Upstream release metadata mismatch: requested version '{clean_ver}' but release declared tag '{tag_name}'"
                )
            return clean_ver, tag_name, rel
        except UpstreamNotFoundError:
            continue

    raise UpstreamNotFoundError(f"OMP release not found for version '{version}' in {OMP_REPO}")


def extract_method_signatures(files: Dict[str, bytes]) -> Dict[str, str]:
    """Inspect RpcClient's declared and inherited API without importing SDK code."""
    classes = {}
    for name, data in files.items():
        if name.endswith(".py"):
            for node in ast.parse(data.decode("utf-8")).body:
                if isinstance(node, ast.ClassDef):
                    classes[node.name] = node

    def collect(name: str, ancestors: Set[str]) -> Dict[str, str]:
        if name in ("object", "Generic", "Protocol"):
            return {}
        if name in ancestors or name not in classes:
            raise UpdateError(f"Cannot statically resolve SDK base class {name}")
        node = classes[name]
        signatures = {}
        for base in node.bases:
            if isinstance(base, ast.Subscript):
                base = base.value
            if not isinstance(base, ast.Name):
                raise UpdateError(f"Cannot statically resolve SDK base {ast.unparse(base)}")
            signatures.update(collect(base.id, ancestors | {name}))
        for method in node.body:
            if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) and not method.name.startswith("_"):
                parameters = re.sub(r"^self(?:,\s*|$)", "", ast.unparse(method.args))
                returns = f" -> {ast.unparse(method.returns)}" if method.returns else ""
                signatures[method.name] = f"{method.name}({parameters}){returns}"
        return signatures

    return collect("RpcClient", set())


def prepare_omp(
    repo_dir: Path,
    version: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """Prepare OMP runtime candidate pins in repo_dir."""
    with repo_flock(repo_dir):
        runtime_lock, runtime_bytes, omp_rpc_lock, omp_rpc_bytes = load_lock_files(repo_dir)

        clean_ver, tag, release = resolve_omp_release(version, timeout=timeout)
        commit_sha = resolve_git_commit(OMP_REPO, tag, timeout=timeout, allow_branch=False)

        # Publisher asset digest verification (.digest, .sha256, or SHA256SUMS*)
        assets = release.get("assets", [])
        publisher_digest_source: Optional[str] = None
        expected_publisher_digest: Optional[str] = None
        binary_asset = next((asset for asset in assets if asset.get("name") == "omp-linux-x64"), {})
        metadata_digest = binary_asset.get("digest")
        metadata_hash = None
        if metadata_digest is not None:
            if not isinstance(metadata_digest, str) or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", metadata_digest):
                raise DigestMismatchError("Invalid GitHub release asset SHA256 digest")
            metadata_hash = metadata_digest.split(":", 1)[1].lower()
            expected_publisher_digest = metadata_hash
            publisher_digest_source = "GitHub release asset.digest"

        # Check for exact binary digest asset first (e.g. omp-linux-x64.sha256 or omp-linux-x64.digest)
        exact_digest_assets = [
            a for a in assets
            if a.get("name", "").lower() in ("omp-linux-x64.sha256", "omp-linux-x64.digest")
        ]
        sums_assets = [
            a for a in assets
            if a.get("name", "").upper() in ("SHA256SUMS.TXT", "SHA256SUMS")
        ]

        # 1. Try exact asset digest
        exact_declared_hash: Optional[str] = None
        if exact_digest_assets:
            aname = exact_digest_assets[0].get("name")
            d_url = exact_digest_assets[0].get("browser_download_url")
            d_bytes = http_get_bytes(d_url, is_api=False, timeout=timeout)
            d_str = d_bytes.decode("utf-8", errors="replace").strip().split()
            if not d_str:
                raise DigestMismatchError(f"Empty publisher digest asset: {aname}")
            candidate = d_str[0].strip().lower()
            if not re.fullmatch(r"[0-9a-f]{64}", candidate):
                raise DigestMismatchError(f"Malformed sha256 checksum '{candidate}' in publisher asset {aname}")
            exact_declared_hash = candidate
            publisher_digest_source = aname
            expected_publisher_digest = candidate

        # 2. Try SHA256SUMS file
        sums_declared_hash: Optional[str] = None
        if sums_assets:
            aname = sums_assets[0].get("name")
            s_url = sums_assets[0].get("browser_download_url")
            s_bytes = http_get_bytes(s_url, is_api=False, timeout=timeout)
            s_content = s_bytes.decode("utf-8", errors="replace")
            for line in s_content.splitlines():
                parts = line.strip().split()
                if len(parts) >= 2 and parts[1].lstrip("*") == "omp-linux-x64":
                    candidate = parts[0].strip().lower()
                    if not re.fullmatch(r"[0-9a-f]{64}", candidate):
                        raise DigestMismatchError(f"Malformed sha256 checksum '{candidate}' in publisher asset {aname}")
                    sums_declared_hash = candidate
                    if not expected_publisher_digest:
                        expected_publisher_digest = candidate
                        publisher_digest_source = aname
                    break

            if not sums_declared_hash:
                raise DigestMismatchError(
                    f"Publisher digest asset '{aname}' exists in release, but no valid entry for 'omp-linux-x64' was found."
                )

        declared_hashes = {value for value in (metadata_hash, exact_declared_hash, sums_declared_hash) if value}
        if len(declared_hashes) > 1:
            raise DigestMismatchError("Publisher digest sources disagree")

        # Download binary and compute SHA256
        binary_url = f"https://github.com/{OMP_REPO}/releases/download/{tag}/omp-linux-x64"
        binary_bytes = http_get_bytes(binary_url, is_api=False, timeout=timeout)
        calculated_binary_sha256 = hashlib.sha256(binary_bytes).hexdigest()

        if expected_publisher_digest:
            if calculated_binary_sha256.lower() != expected_publisher_digest:
                raise DigestMismatchError(
                    f"Binary digest mismatch: calculated {calculated_binary_sha256} but publisher "
                    f"asset '{publisher_digest_source}' declared {expected_publisher_digest}"
                )
            digest_verification_status = f"VERIFIED (matched publisher asset {publisher_digest_source})"
        else:
            digest_verification_status = "LOCAL_ONLY (no publisher digest asset found in release; calculated locally)"

        # Fetch matching Python RPC SDK files and license from the same commit
        tree_url = f"https://api.github.com/repos/{OMP_REPO}/git/trees/{commit_sha}?recursive=1"
        tree_data = http_get_json(tree_url, is_api=True, timeout=timeout)

        if tree_data.get("truncated") is True:
            raise UpdateError(f"Git tree for commit {commit_sha} was truncated by GitHub API; unable to verify full SDK")

        sdk_prefix: Optional[str] = None
        for cand_prefix in ["sdk/python/omp-rpc/", "python/omp-rpc/"]:
            if any(item.get("path", "").startswith(cand_prefix) for item in tree_data.get("tree", [])):
                sdk_prefix = cand_prefix
                break

        if not sdk_prefix:
            raise UpdateError(f"Could not find Python RPC SDK in git tree for commit {commit_sha}")

        src_prefix = sdk_prefix + "src/omp_rpc/"
        discovered_files: List[str] = [
            item.get("path", "")[len(src_prefix):]
            for item in tree_data.get("tree", [])
            if item.get("path", "").startswith(src_prefix) and item.get("type") == "blob" and item.get("path", "")[len(src_prefix):]
        ]

        if not discovered_files:
            raise UpdateError(f"No Python RPC SDK source files found under {src_prefix} in tree {commit_sha}")

        sdk_base_rel = sdk_prefix.rstrip("/")
        base_raw = f"https://raw.githubusercontent.com/{OMP_REPO}/{commit_sha}/{sdk_base_rel}"

        new_rpc_files_hashes: Dict[str, str] = {}
        new_rpc_files_contents: Dict[str, bytes] = {}

        for fname in sorted(discovered_files):
            furl = f"{base_raw}/src/omp_rpc/{fname}"
            fbytes = http_get_bytes(furl, is_api=False, timeout=timeout)
            new_rpc_files_contents[fname] = fbytes
            new_rpc_files_hashes[fname] = hashlib.sha256(fbytes).hexdigest()

        license_url = f"{base_raw}/LICENSE"
        license_bytes = http_get_bytes(license_url, is_api=False, timeout=timeout)
        license_sha256 = hashlib.sha256(license_bytes).hexdigest()

        # SDK file checksum comparison against baseline lock
        baseline_files = omp_rpc_lock.get("files", {})
        added_sdk_files = sorted(list(new_rpc_files_hashes.keys() - baseline_files.keys()))
        removed_sdk_files = sorted(list(baseline_files.keys() - new_rpc_files_hashes.keys()))
        modified_sdk_files = sorted([
            f for f in new_rpc_files_hashes.keys() & baseline_files.keys()
            if new_rpc_files_hashes[f] != baseline_files[f]
        ])

        # Method signatures diff analysis
        new_signatures: Optional[Dict[str, str]] = None
        methods_status = "unverified"
        if "client.py" in new_rpc_files_contents:
            try:
                new_signatures = extract_method_signatures(new_rpc_files_contents)
            except Exception as e:
                methods_status = f"unverified: new client.py parse failure ({e})"

        orig_sdk_path = omp_rpc_lock["sourcePath"]
        old_sdk_base = f"https://raw.githubusercontent.com/{OMP_REPO}/{omp_rpc_lock['commit']}/{orig_sdk_path}/src/omp_rpc"
        old_signatures: Optional[Dict[str, str]] = None

        if new_signatures is not None:
            try:
                old_files = {
                    name: http_get_bytes(f"{old_sdk_base}/{name}", is_api=False, timeout=timeout)
                    for name in omp_rpc_lock["files"] if name.endswith(".py")
                }
                if any(hashlib.sha256(data).hexdigest() != omp_rpc_lock["files"][name] for name, data in old_files.items()):
                    raise DigestMismatchError("Baseline RPC SDK differs from its pinned checksums")
                old_signatures = extract_method_signatures(old_files)
                methods_status = "verified"
            except Exception as e:
                methods_status = f"unverified: baseline client.py fetch/parse failure ({e})"

        if methods_status == "verified" and new_signatures is not None and old_signatures is not None:
            added_methods = [new_signatures[m] for m in sorted(new_signatures.keys() - old_signatures.keys())]
            removed_methods = [old_signatures[m] for m in sorted(old_signatures.keys() - new_signatures.keys())]
            changed_signatures = [
                f"{m}: {old_signatures[m]} -> {new_signatures[m]}"
                for m in sorted(new_signatures.keys() & old_signatures.keys())
                if old_signatures[m] != new_signatures[m]
            ]
        else:
            added_methods = None
            removed_methods = None
            changed_signatures = None

        # Scoped RpcCommand union parsing from rpc-types.ts
        ts_url = f"https://raw.githubusercontent.com/{OMP_REPO}/{commit_sha}/packages/coding-agent/src/modes/rpc/rpc-types.ts"
        upstream_commands: Optional[Set[str]] = None
        commands_status = "unverified"

        try:
            ts_bytes = http_get_bytes(ts_url, is_api=False, timeout=timeout)
            ts_text = ts_bytes.decode("utf-8", errors="replace")
            # Field semicolons inside multiline members do not terminate the union.
            cmd_match = re.search(
                r"^export\s+type\s+RpcCommand\s*=\s*\n(.*?)(?=^export\s|\Z)",
                ts_text, re.DOTALL | re.MULTILINE,
            )
            if cmd_match:
                found_cmds = set(re.findall(r'type:\s*["\']([a-zA-Z0-9_]+)["\']', cmd_match.group(1)))
                if found_cmds:
                    upstream_commands = found_cmds
                    commands_status = "verified"
                else:
                    commands_status = "unverified (no command types in RpcCommand union block)"
            else:
                commands_status = "unverified (RpcCommand union not matched in rpc-types.ts)"
        except Exception as e:
            commands_status = f"unverified ({e})"

        plugin_supported_commands = extract_plugin_supported_commands(repo_dir)

        if upstream_commands is not None:
            added_upstream_commands = sorted(list(upstream_commands - plugin_supported_commands))
            removed_upstream_commands = sorted(list(plugin_supported_commands - upstream_commands))
        else:
            added_upstream_commands = None
            removed_upstream_commands = None

        # Construct updated candidate locks
        candidate_runtime_lock = json.loads(json.dumps(runtime_lock))
        candidate_runtime_lock["versions"]["omp"] = clean_ver
        candidate_runtime_lock["runtimeInputs"]["omp"]["url"] = binary_url
        candidate_runtime_lock["runtimeInputs"]["omp"]["sha256"] = calculated_binary_sha256

        candidate_omp_rpc_lock = {
            "version": clean_ver,
            "commit": commit_sha,
            "sourcePath": sdk_base_rel,
            "files": new_rpc_files_hashes,
            "licenseSha256": license_sha256,
        }

        new_runtime_text = json.dumps(candidate_runtime_lock, indent=2) + "\n"
        new_omp_rpc_text = json.dumps(candidate_omp_rpc_lock, indent=2) + "\n"

        runtime_path = repo_dir / "deploy" / "runtime-lock.json"
        omp_rpc_path = repo_dir / "deploy" / "hermes" / "omp-rpc-lock.json"

        verify_and_save_atomic(
            original_snapshots={runtime_path: runtime_bytes, omp_rpc_path: omp_rpc_bytes},
            staged_contents={omp_rpc_path: new_omp_rpc_text, runtime_path: new_runtime_text},
        )

        review_notes = [
            "WARNING: Pinned candidate preparation != verified compatibility.",
            "Candidate lock files prepared for isolated testing and review.",
            "Native plugin allowlist (SUPPORTED_COMMANDS) was NOT modified.",
            "Manual compatibility testing is REQUIRED before deployment.",
            "Crash atomicity limit: sequential replacement with in-memory rollback protects against "
            "filesystem errors. Cross-file power-loss atomicity is explicitly unsupported; subsequent "
            "updater invocations validate coupled locks to reject partial states.",
        ]

        return {
            "status": "prepared",
            "target": "omp",
            "version": clean_ver,
            "release_tag": tag,
            "commit": commit_sha,
            "binary_url": binary_url,
            "binary_sha256": calculated_binary_sha256,
            "publisher_digest_status": digest_verification_status,
            "sdk_source_path": sdk_base_rel,
            "rpc_files_count": len(new_rpc_files_hashes),
            "license_sha256": license_sha256,
            "sdk_file_changes": {
                "added_files": added_sdk_files,
                "removed_files": removed_sdk_files,
                "modified_files": modified_sdk_files,
            },
            "rpc_diff": {
                "methods_verification_status": methods_status,
                "added_methods": added_methods,
                "removed_methods": removed_methods,
                "changed_signatures": changed_signatures,
                "commands_verification_status": commands_status,
                "added_upstream_commands": added_upstream_commands,
                "removed_upstream_commands": removed_upstream_commands,
                "plugin_allowlist_modified": False,
            },
            "review_notice": "\n".join(review_notes),
        }


def parse_pyproject_dependencies(content: str) -> Dict[str, List[str]]:
    """Read dependency values as TOML, preserving optional group identity."""
    project = tomllib.loads(content)["project"]
    dependencies = project.get("dependencies", [])
    optional = project.get("optional-dependencies", {})
    values = [dependencies, *optional.values()]
    if any(not isinstance(items, list) or not all(isinstance(item, str) for item in items) for items in values):
        raise ValueError("Project dependencies must be arrays of strings")
    return {
        "dependencies": sorted(dependencies),
        "optional_dependencies": sorted(f"{group}: {dep}" for group, deps in optional.items() for dep in deps),
    }


def archive_dependencies(data: bytes) -> Dict[str, bytes]:
    files = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive.getmembers():
                relative = member.name.split("/", 1)[-1]
                if member.isfile() and (
                    relative in ("pyproject.toml", "requirements.txt", "setup.py", "uv.lock")
                    or relative.startswith("requirements")
                ):
                    with archive.extractfile(member) as stream:
                        files[relative] = stream.read()
    except (tarfile.TarError, OSError) as error:
        raise UpdateError(f"Invalid Hermes source archive: {error}") from error
    return files


def prepare_hermes(
    repo_dir: Path,
    ref: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """Prepare Hermes runtime candidate pins in repo_dir."""
    with repo_flock(repo_dir):
        runtime_lock, runtime_bytes, omp_rpc_lock, omp_rpc_bytes = load_lock_files(repo_dir)

        commit_sha = resolve_git_commit(HERMES_REPO, ref, timeout=timeout, allow_branch=False)

        archive_url = f"https://codeload.github.com/{HERMES_REPO}/tar.gz/{commit_sha}"
        archive_bytes = http_get_bytes(archive_url, is_api=False, timeout=timeout)
        archive_sha256 = hashlib.sha256(archive_bytes).hexdigest()

        new_dep_files = archive_dependencies(archive_bytes)
        old_commit = runtime_lock["versions"]["hermesSource"]
        old_archive = archive_bytes if old_commit == commit_sha else http_get_bytes(
            f"https://codeload.github.com/{HERMES_REPO}/tar.gz/{old_commit}",
            is_api=False, timeout=timeout,
        )
        if hashlib.sha256(old_archive).hexdigest() != runtime_lock["hermes"]["sourceSha256"]:
            raise DigestMismatchError("Baseline Hermes archive differs from its pinned SHA256")
        old_dep_files = archive_dependencies(old_archive)

        added_dep_files = sorted(list(new_dep_files.keys() - old_dep_files.keys()))
        removed_dep_files = sorted(list(old_dep_files.keys() - new_dep_files.keys()))
        modified_dep_files = sorted([
            f for f in new_dep_files.keys() & old_dep_files.keys()
            if hashlib.sha256(new_dep_files[f]).hexdigest() != hashlib.sha256(old_dep_files[f]).hexdigest()
        ])

        pyproject_diff: Dict[str, Any] = {"status": "uncompared"}
        if "pyproject.toml" in new_dep_files and "pyproject.toml" in old_dep_files:
            try:
                old_parsed = parse_pyproject_dependencies(old_dep_files["pyproject.toml"].decode("utf-8"))
                new_parsed = parse_pyproject_dependencies(new_dep_files["pyproject.toml"].decode("utf-8"))
                pyproject_diff = {
                    "status": "compared",
                    "added_dependencies": sorted(list(set(new_parsed["dependencies"]) - set(old_parsed["dependencies"]))),
                    "removed_dependencies": sorted(list(set(old_parsed["dependencies"]) - set(new_parsed["dependencies"]))),
                    "added_optional": sorted(list(set(new_parsed["optional_dependencies"]) - set(old_parsed["optional_dependencies"]))),
                    "removed_optional": sorted(list(set(old_parsed["optional_dependencies"]) - set(new_parsed["optional_dependencies"]))),
                }
            except Exception as e:
                pyproject_diff = {"status": f"unverified: pyproject parse failure ({e})"}

        # Construct updated candidate root lock, strictly preserving all unrelated pins
        candidate_runtime_lock = json.loads(json.dumps(runtime_lock))
        candidate_runtime_lock["versions"]["hermesSource"] = commit_sha
        candidate_runtime_lock["hermes"]["sourceUrl"] = archive_url
        candidate_runtime_lock["hermes"]["sourceSha256"] = archive_sha256

        new_runtime_text = json.dumps(candidate_runtime_lock, indent=2) + "\n"

        runtime_path = repo_dir / "deploy" / "runtime-lock.json"
        omp_rpc_path = repo_dir / "deploy" / "hermes" / "omp-rpc-lock.json"

        verify_and_save_atomic(
            original_snapshots={runtime_path: runtime_bytes, omp_rpc_path: omp_rpc_bytes},
            staged_contents={runtime_path: new_runtime_text},
        )

        return {
            "status": "prepared",
            "target": "hermes",
            "requested_ref": ref,
            "resolved_commit": commit_sha,
            "archive_url": archive_url,
            "archive_sha256": archive_sha256,
            "sqlite_pinned_version": runtime_lock.get("hermes", {}).get("sqliteVersion"),
            "sqlite_pinned_sha256": runtime_lock.get("hermes", {}).get("sqliteSha256"),
            "dependency_inventory": {
                "added_files": added_dep_files,
                "removed_files": removed_dep_files,
                "modified_files": modified_dep_files,
            },
            "pyproject_diff": pyproject_diff,
            "omp_rpc_lock_untouched": True,
            "plugin_allowlist_modified": False,
            "review_notice": (
                "WARNING: Pinned candidate preparation != verified compatibility.\n"
                "Candidate lock files prepared for isolated testing and review.\n"
                "Unrelated pins (SQLite, media inputs, assets) strictly preserved.\n"
                "Native plugin allowlist (SUPPORTED_COMMANDS) was NOT modified.\n"
                "Manual compatibility testing is REQUIRED before deployment.\n"
                "Crash atomicity limit: sequential replacement with in-memory rollback protects against "
                "filesystem errors. Cross-file power-loss atomicity is explicitly unsupported; subsequent "
                "updater invocations validate coupled locks to reject partial states."
            ),
        }


def format_prepare_omp_text(result: Dict[str, Any]) -> str:
    """Format prepare omp result as human-readable text."""
    diff = result["rpc_diff"]
    s_changes = result.get("sdk_file_changes", {})
    lines = [
        "============================================================",
        "OMP Candidate Preparation Report",
        "============================================================",
        f"Target version:     {result['version']}",
        f"Release tag:        {result['release_tag']}",
        f"Release commit:     {result['commit']}",
        f"Binary URL:         {result['binary_url']}",
        f"Binary SHA256:      {result['binary_sha256']}",
        f"Publisher digest:   {result['publisher_digest_status']}",
        f"Python SDK path:    {result['sdk_source_path']}",
        f"Python SDK files:   {result['rpc_files_count']} files checksum-locked",
        f"License SHA256:     {result['license_sha256']}",
        "",
        "Updated Lock Files:",
        "  - deploy/runtime-lock.json (versions.omp, runtimeInputs.omp)",
        "  - deploy/hermes/omp-rpc-lock.json (version, commit, sourcePath, files, licenseSha256)",
        "",
        "SDK Schema File Changes:",
        f"  Added files:      {', '.join(s_changes.get('added_files', [])) if s_changes.get('added_files') else 'None'}",
        f"  Removed files:    {', '.join(s_changes.get('removed_files', [])) if s_changes.get('removed_files') else 'None'}",
        f"  Modified files:   {', '.join(s_changes.get('modified_files', [])) if s_changes.get('modified_files') else 'None'}",
        "",
        "RPC / Schema Diff Analysis:",
    ]
    if diff["methods_verification_status"] == "verified":
        lines.append(f"  Added client methods:    {', '.join(diff['added_methods']) if diff['added_methods'] else 'None'}")
        lines.append(f"  Removed client methods:  {', '.join(diff['removed_methods']) if diff['removed_methods'] else 'None'}")
        lines.append(f"  Changed signatures:      {', '.join(diff['changed_signatures']) if diff['changed_signatures'] else 'None'}")
    else:
        lines.append(f"  Client methods diff:     UNVERIFIED ({diff['methods_verification_status']})")

    lines.append(f"  Upstream commands check: {diff['commands_verification_status']}")
    if diff["added_upstream_commands"] is not None:
        lines.append(f"  Upstream commands added:   {', '.join(diff['added_upstream_commands']) if diff['added_upstream_commands'] else 'None'}")
        lines.append(f"  Upstream commands removed: {', '.join(diff['removed_upstream_commands']) if diff['removed_upstream_commands'] else 'None'}")
    else:
        lines.append("  Upstream commands diff:    UNVERIFIED")

    lines.extend([
        "  Plugin allowlist status: UNTOUCHED (hermes-plugin/omp-executor/executor.py retained)",
        "",
        "Risk & Review Notice:",
        result["review_notice"],
        "============================================================",
    ])
    return "\n".join(lines)


def format_prepare_hermes_text(result: Dict[str, Any]) -> str:
    """Format prepare hermes result as human-readable text."""
    pdiff = result.get("pyproject_diff", {})
    inv = result.get("dependency_inventory", {})
    lines = [
        "============================================================",
        "Hermes Candidate Preparation Report",
        "============================================================",
        f"Requested ref:      {result['requested_ref']}",
        f"Resolved commit:    {result['resolved_commit']}",
        f"Archive URL:        {result['archive_url']}",
        f"Archive SHA256:     {result['archive_sha256']}",
        f"Unrelated pins:     SQLite {result['sqlite_pinned_version']} and media dependencies preserved intact",
        "",
        "Dependency Inventory Changes:",
        f"  Added dep files:    {', '.join(inv.get('added_files', [])) if inv.get('added_files') else 'None'}",
        f"  Removed dep files:  {', '.join(inv.get('removed_files', [])) if inv.get('removed_files') else 'None'}",
        f"  Modified dep files: {', '.join(inv.get('modified_files', [])) if inv.get('modified_files') else 'None'}",
    ]
    if pdiff.get("status") == "compared":
        lines.append(f"  Added pyproject deps:   {', '.join(pdiff.get('added_dependencies', [])) if pdiff.get('added_dependencies') else 'None'}")
        lines.append(f"  Removed pyproject deps: {', '.join(pdiff.get('removed_dependencies', [])) if pdiff.get('removed_dependencies') else 'None'}")
    else:
        lines.append(f"  Pyproject comparison:   {pdiff.get('status')}")

    lines.extend([
        "",
        "Updated Lock Files:",
        "  - deploy/runtime-lock.json (versions.hermesSource, hermes.sourceUrl, hermes.sourceSha256)",
        "  - deploy/hermes/omp-rpc-lock.json (UNTOUCHED)",
        "",
        "Plugin & Compatibility Status:",
        "  Plugin allowlist status: UNTOUCHED (hermes-plugin/omp-executor/executor.py retained)",
        "",
        "Risk & Review Notice:",
        result["review_notice"],
        "============================================================",
    ])
    return "\n".join(lines)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Unified OMP and Hermes runtime updater.")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    check_p = subparsers.add_parser("check", help="Check current pins against upstream latest releases (read-only)")
    check_p.add_argument("--repo", type=Path, default=None, help="Repository root path (defaults to script's checkout)")
    check_p.add_argument("--format", choices=["text", "json"], default="text", help="Output format (default: text)")

    prep_p = subparsers.add_parser("prepare", help="Prepare runtime candidates")
    prep_sub = prep_p.add_subparsers(dest="target", required=True)

    omp_p = prep_sub.add_parser("omp", help="Prepare OMP runtime candidate")
    omp_p.add_argument("--version", required=True, help="Exact release version (e.g. 18.4.4 or 18.6.0)")
    omp_p.add_argument("--repo", type=Path, default=None, help="Repository root path (defaults to script's checkout)")
    omp_p.add_argument("--format", choices=["text", "json"], default="text", help="Output format (default: text)")

    hermes_p = prep_sub.add_parser("hermes", help="Prepare Hermes runtime candidate")
    hermes_p.add_argument("--ref", required=True, help="Exact tag or 40-character commit SHA (branches rejected)")
    hermes_p.add_argument("--repo", type=Path, default=None, help="Repository root path (defaults to script's checkout)")
    hermes_p.add_argument("--format", choices=["text", "json"], default="text", help="Output format (default: text)")

    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    default_repo = Path(__file__).resolve().parent.parent
    repo_dir = (args.repo.resolve() if args.repo else default_repo)

    try:
        if args.subcommand == "check":
            result = check_runtime(repo_dir)
            if args.format == "json":
                print(json.dumps(result, indent=2))
            else:
                print(format_check_text(result))
            return 0

        elif args.subcommand == "prepare":
            if args.target == "omp":
                result = prepare_omp(repo_dir, version=args.version)
                if args.format == "json":
                    print(json.dumps(result, indent=2))
                else:
                    print(format_prepare_omp_text(result))
                return 0
            elif args.target == "hermes":
                result = prepare_hermes(repo_dir, ref=args.ref)
                if args.format == "json":
                    print(json.dumps(result, indent=2))
                else:
                    print(format_prepare_hermes_text(result))
                return 0

        print(f"Unknown command: {args.subcommand}", file=sys.stderr)
        return 1

    except UpdateError as e:
        if getattr(args, "format", "text") == "json":
            print(json.dumps({"status": "error", "error": str(e)}, indent=2), file=sys.stderr)
        else:
            print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        if getattr(args, "format", "text") == "json":
            print(json.dumps({"status": "error", "error": f"Unexpected failure: {e}"}, indent=2), file=sys.stderr)
        else:
            print(f"Unexpected failure: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
