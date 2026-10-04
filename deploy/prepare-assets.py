#!/usr/bin/env python3
"""Fetch pinned runtime inputs or initialize/check external media assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

LOCK = Path(__file__).with_name('runtime-lock.json')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def download(spec, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=destination.parent, prefix='.download-')
    temporary = Path(temporary)
    try:
        request = urllib.request.Request(spec['url'], headers={'User-Agent': 'omp-video-bridge/2.0.1'})
        with os.fdopen(fd, 'wb') as output, urllib.request.urlopen(request, timeout=120) as response:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        actual = digest(temporary)
        if actual != spec['sha256']:
            raise RuntimeError(f"SHA256 mismatch for {spec['url']}: expected {spec['sha256']}, got {actual}")
        temporary.chmod(0o644)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def runtime_inputs(lock, root, select=None):
    root.mkdir(parents=True, exist_ok=True)
    selected_keys = set(select) if select else None
    if selected_keys is not None:
        missing = selected_keys - set(lock.get('runtimeInputs', {}).keys())
        if missing:
            raise ValueError(f"Selected runtime input(s) {sorted(missing)} not found in lock file")
    with tempfile.TemporaryDirectory(dir=root, prefix='.inputs-') as work:
        work = Path(work)
        for name, spec in lock['runtimeInputs'].items():
            if selected_keys is not None and name not in selected_keys:
                continue
            archive = work / name
            download(spec, archive)
            destination = root / spec['destination']
            if spec['kind'] == 'file':
                destination.parent.mkdir(parents=True, exist_ok=True)
                archive.replace(destination)
                destination.chmod(spec.get('mode', 0o644))
                continue
            unpacked = work / f'{name}-unpacked'
            unpacked.mkdir()
            with tarfile.open(archive) as source:
                source.extractall(unpacked, filter='data')
            source_root = unpacked / spec['archiveRoot']
            if spec.get('select'):
                destination.mkdir(parents=True, exist_ok=True)
                for skill in spec['select']:
                    shutil.copytree(source_root / skill, destination / skill, symlinks=True)
            else:
                shutil.copytree(source_root, destination, symlinks=True)
    print(f"Pinned runtime build inputs{f' ({sorted(selected_keys)})' if selected_keys else ''} downloaded and verified.")

def fingerprint(assets):
    return hashlib.sha256(json.dumps(assets, sort_keys=True).encode()).hexdigest()


def chrome_tree(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*')) if p.is_file()}


def receipt(root, assets):
    path = root / 'assets.json'
    if not path.is_file():
        raise RuntimeError('Assets are not initialized; run deploy/setup.sh init first.')
    value = json.loads(path.read_text())
    if value.get('lock_sha256') != fingerprint(assets):
        raise RuntimeError('Assets do not match runtime-lock.json; stop the worker and rerun asset initialization.')
    return value


def check(root, assets):
    value = receipt(root, assets)
    for name, spec in assets['models'].items():
        path = root / spec['path']
        if not path.is_file() or digest(path) != spec['sha256']:
            raise RuntimeError(f'Asset checksum failed: {name} ({path}); rerun asset initialization.')
    chrome = root / 'chrome'
    binary = chrome / 'chrome-headless-shell'
    if not binary.is_file() or digest(binary) != assets['chrome']['binarySha256']:
        raise RuntimeError('Chrome binary checksum failed; rerun asset initialization.')
    if not value.get('chrome_files') or chrome_tree(chrome) != value['chrome_files']:
        raise RuntimeError('Chrome tree checksum failed; rerun asset initialization.')
    if not os.access(binary, os.X_OK):
        raise RuntimeError('Chrome binary is not executable.')
    print('External models and complete Chrome tree verified.')


def initialize(root, assets):
    root.mkdir(parents=True, exist_ok=True)
    for name, spec in assets['models'].items():
        path = root / spec['path']
        if path.is_file() and digest(path) == spec['sha256']:
            print(f'Reusing verified {name}.')
        else:
            print(f'Downloading pinned {name}.', flush=True)
            download(spec, path)
    spec = assets['chrome']
    chrome = root / 'chrome'
    reusable = False
    try:
        previous = receipt(root, assets)
        binary = chrome / 'chrome-headless-shell'
        reusable = binary.is_file() and digest(binary) == spec['binarySha256'] and chrome_tree(chrome) == previous['chrome_files']
    except (RuntimeError, KeyError, ValueError):
        pass
    if not reusable:
        print(f"Downloading pinned Chrome {spec['version']}.", flush=True)
        with tempfile.TemporaryDirectory(dir=root, prefix='.chrome-') as work:
            work = Path(work)
            archive = work / 'chrome.zip'
            download(spec, archive)
            unpacked = work / 'unpacked'
            with zipfile.ZipFile(archive) as source:
                for member in source.infolist():
                    relative = Path(member.filename)
                    if relative.is_absolute() or '..' in relative.parts:
                        raise RuntimeError(f'Unsafe Chrome archive path: {member.filename}')
                    source.extract(member, unpacked)
                    target = unpacked / relative
                    if not member.is_dir():
                        target.chmod((member.external_attr >> 16) & 0o777 or 0o644)
            tree = unpacked / spec['archiveRoot']
            if digest(tree / 'chrome-headless-shell') != spec['binarySha256']:
                raise RuntimeError('Downloaded Chrome binary differs from the pinned runtime binary.')
            if chrome.exists():
                shutil.rmtree(chrome)
            tree.replace(chrome)
    value = {'lock_sha256': fingerprint(assets), 'chrome_files': chrome_tree(chrome)}
    temporary = root / '.assets.json'
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o644)
    temporary.replace(root / 'assets.json')
    check(root, assets)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--runtime', action='store_true', help='Fetch only runtime image build inputs')
    mode.add_argument('--check', action='store_true', help='Validate assets without network or writes')
    parser.add_argument('--lock', type=Path, default=None, help='Path to lock file (defaults to runtime-lock.json)')
    parser.add_argument('--select', action='append', default=[], help='Select specific runtime inputs to fetch')
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    lock_path = args.lock if args.lock is not None else LOCK
    if not lock_path.is_file():
        fallback = Path(__file__).with_name('media-runtime-lock.json')
        if fallback.is_file():
            lock_path = fallback
        else:
            raise FileNotFoundError(f"Missing lock file: {lock_path}")
    lock = json.loads(lock_path.read_text(encoding='utf-8'))
    if args.runtime:
        runtime_inputs(lock, args.destination, select=args.select)
    elif args.check:
        check(args.destination, lock['assets'])
    else:
        initialize(args.destination, lock['assets'])
if __name__ == '__main__':
    main()
