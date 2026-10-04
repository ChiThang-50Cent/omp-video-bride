#!/usr/bin/env python3
"""Synthesize a batch of narration lines with one Kokoro model load.

The Node audio adapter writes a manifest containing absolute output paths.  This
helper deliberately has no provider/network fallback: loading the pinned
kokoro-onnx runtime and model is a hard requirement for this pipeline.
"""

from __future__ import annotations

import argparse
import json
import math
import hashlib
import importlib.metadata
import platform
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


MODEL_NAMES = ("kokoro-v1.0.onnx", "kokoro-v0_19.onnx")
VOICE_NAMES = ("voices-v1.0.bin", "voices.bin")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="batch_tts.py",
        description="Synthesize all manifest lines with one local kokoro-onnx model load.",
    )
    parser.add_argument("--input", "--manifest", dest="manifest", help="JSON batch manifest")
    parser.add_argument("--resolve-assets", action="store_true", help="Print resolved asset fingerprints/runtime identity without loading Kokoro")
    parser.add_argument("--result", "--output-json", dest="result", help="JSON result path (default: stdout only)")
    parser.add_argument("--model", help="Kokoro ONNX model; defaults to pinned runtime asset")
    parser.add_argument("--voices", help="Kokoro voice pack; defaults to pinned runtime asset")
    return parser


def _asset_from_env(names: tuple[str, ...], filenames: tuple[str, ...]) -> Path | None:
    roots = []
    for name in names:
        value = os.environ.get(name)
        if value:
            roots.append(Path(value).expanduser())
    roots.extend(
        [
            Path("/assets/tts/models"),
            Path("/assets/tts/voices"),
            Path.home() / ".cache" / "hyperframes" / "tts" / "models",
            Path.home() / ".cache" / "hyperframes" / "tts" / "voices",
            Path.home() / ".cache" / "hyperframes" / "tts",
        ]
    )
    for root in roots:
        if root.is_file():
            return root
        for filename in filenames:
            candidate = root / filename
            if candidate.is_file():
                return candidate
    return None


def _resolve_assets(model_arg: str | None, voices_arg: str | None) -> tuple[Path, Path]:
    model = Path(model_arg).expanduser() if model_arg else _asset_from_env(
        ("KOKORO_MODEL", "KOKORO_MODEL_PATH", "HYPERFRAMES_KOKORO_MODEL", "HYPERFRAMES_TTS_MODEL"),
        MODEL_NAMES,
    )
    voices = Path(voices_arg).expanduser() if voices_arg else _asset_from_env(
        ("KOKORO_VOICES", "KOKORO_VOICES_PATH", "HYPERFRAMES_KOKORO_VOICES", "HYPERFRAMES_TTS_VOICES"),
        VOICE_NAMES,
    )
    if model is None or not model.is_file():
        raise RuntimeError(
            "Kokoro ONNX model not found; expected /assets/tts/models/kokoro-v1.0.onnx "
            "or set KOKORO_MODEL_PATH/HYPERFRAMES_KOKORO_MODEL"
        )
    if voices is None or not voices.is_file():
        raise RuntimeError(
            "Kokoro voice pack not found; expected /assets/tts/voices/voices-v1.0.bin "
            "or set KOKORO_VOICES_PATH/HYPERFRAMES_KOKORO_VOICES"
        )
    return model.resolve(), voices.resolve()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _identity(model: Path, voices: Path) -> dict[str, Any]:
    # Distribution metadata and implementation bytes require no model or runtime
    # imports. Hash local Python/native implementations as well as their versions:
    # editable installs or same-version replacements must not retain cached WAVs.
    packages = {}
    for name in ("kokoro-onnx", "onnxruntime", "numpy", "soundfile", "phonemizer", "espeakng-loader"):
        try:
            distribution = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
            continue
        implementations = {}
        for file in sorted(distribution.files or [], key=str):
            path = Path(distribution.locate_file(file))
            if path.is_file() and (path.suffix in (".py", ".so", ".dll", ".dylib") or ".so." in path.name):
                implementations[str(file)] = _sha256(path)
        packages[name] = {"version": distribution.version, "implementations": implementations}
    return {
        "schema": "kokoro-wav-v2",
        "model": {"path": str(model), "sha256": _sha256(model)},
        "voices": {"path": str(voices), "sha256": _sha256(voices)},
        "implementation_sha256": _sha256(Path(__file__).resolve()),
        "runtime": {"python": sys.version, "platform": platform.platform(), "machine": platform.machine(), "packages": packages},
        "output": {"format": "WAV", "subtype": "PCM_16"},
    }


def _atomic_write_audio(soundfile: Any, output: Path, samples: Any, sample_rate: int) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".wav", dir=output.parent)
    os.close(fd)
    temporary_path = Path(temporary)
    try:
        soundfile.write(str(temporary_path), samples, sample_rate, format="WAV", subtype="PCM_16")
        os.replace(temporary_path, output)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
    return output.stat().st_size


def _load_manifest(path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - message is the user-facing contract
        raise RuntimeError(f"cannot parse batch manifest {path}: {exc}") from exc
    lines = payload.get("lines") if isinstance(payload, dict) else payload
    if not isinstance(lines, list) or not lines:
        raise RuntimeError("batch manifest must contain a non-empty 'lines' array")
    records: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        if not isinstance(line, dict):
            raise RuntimeError(f"manifest line {index + 1} is not an object")
        text = str(line.get("text", ""))
        output = line.get("output") or line.get("path")
        if not text.strip():
            raise RuntimeError(f"manifest line {line.get('id', index + 1)} has empty text")
        if not output:
            raise RuntimeError(f"manifest line {line.get('id', index + 1)} has no output path")
        voice = line.get("voice")
        if not isinstance(voice, str) or not voice:
            raise RuntimeError(f"manifest line {line.get('id', index + 1)} has no voice")
        try:
            speed = float(line.get("speed", 1.0))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"manifest line {line.get('id', index + 1)} has invalid speed") from exc
        if not math.isfinite(speed) or speed <= 0:
            raise RuntimeError(f"manifest line {line.get('id', index + 1)} speed must be positive")
        records.append(
            {
                "id": str(line.get("id", index + 1)),
                "text": text,
                "output": str(output),
                "voice": voice,
                "speed": speed,
            }
        )
    return records


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if not args.resolve_assets and not args.manifest:
        parser.error("--input is required unless --resolve-assets is used")
    try:
        model, voices = _resolve_assets(args.model, args.voices)
        if args.resolve_assets:
            print(json.dumps(_identity(model, voices), separators=(",", ":"), sort_keys=True))
            return 0
        manifest_path = Path(args.manifest).expanduser().resolve()
        if not manifest_path.is_file():
            raise RuntimeError(f"manifest not found: {manifest_path}")
        records = _load_manifest(manifest_path)
        try:
            from kokoro_onnx import Kokoro  # type: ignore[import-not-found]
            import soundfile  # type: ignore[import-not-found]
        except Exception as exc:
            raise RuntimeError(
                "pinned Kokoro runtime is unavailable; use HYPERFRAMES_PYTHON with kokoro-onnx==0.6.1 "
                "and soundfile installed"
            ) from exc

        # This is intentionally the only model construction in the process.  The
        # caller sends all cache misses in one manifest, avoiding one cold load per
        # frame and making the model's memory footprint bounded.
        kokoro = Kokoro(str(model), str(voices))
        result_lines: list[dict[str, Any]] = []
        for record in records:
            samples, sample_rate = kokoro.create(
                record["text"],
                voice=record["voice"],
                speed=record["speed"],
            )
            try:
                rate = int(sample_rate)
            except (TypeError, ValueError) as exc:
                raise RuntimeError(f"line {record['id']} returned an invalid sample rate") from exc
            if rate <= 0:
                raise RuntimeError(f"line {record['id']} returned an invalid sample rate")
            output = Path(record["output"]).expanduser().resolve()
            byte_count = _atomic_write_audio(soundfile, output, samples, rate)
            result_lines.append(
                {
                    "id": record["id"],
                    "output": str(output),
                    "sample_rate": rate,
                    "bytes": byte_count,
                }
            )
        result = {
            "ok": True,
            "model": str(model),
            "voices": str(voices),
            "model_loads": 1,
            "lines": result_lines,
        }
        rendered = json.dumps(result, separators=(",", ":"))
        if args.result:
            result_path = Path(args.result).expanduser().resolve()
            result_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = result_path.with_name(f".{result_path.name}.{os.getpid()}.tmp")
            temporary.write_text(rendered + "\n", encoding="utf-8")
            os.replace(temporary, result_path)
        print(rendered)
        return 0
    except Exception as exc:
        print(f"batch_tts.py: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
