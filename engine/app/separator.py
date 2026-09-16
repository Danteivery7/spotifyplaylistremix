from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class StemBundle:
    vocals: str | None
    instrumental: str | None


def stems_enabled() -> bool:
    return os.getenv("ENABLE_STEMS", "false").lower() in {"1", "true", "yes", "on"}


def _cache_key(input_path: str, model: str) -> str:
    path = Path(input_path).resolve()
    stat = path.stat()
    payload = f"{path}|{stat.st_size}|{stat.st_mtime_ns}|{model}".encode()
    return hashlib.sha1(payload).hexdigest()[:20]


def _find_stems(directory: Path) -> StemBundle:
    files = sorted(directory.glob("*.flac")) + sorted(directory.glob("*.wav"))
    vocals: str | None = None
    instrumental: str | None = None
    for path in files:
        name = path.name.lower()
        if "instrumental" in name or "no_vocals" in name or "no vocals" in name:
            instrumental = str(path)
        elif "vocals" in name or "vocal" in name:
            vocals = str(path)
    return StemBundle(vocals=vocals, instrumental=instrumental)


def separate_vocals_instrumental(input_path: str) -> StemBundle | None:
    if not stems_enabled():
        return None

    model = os.getenv("STEM_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    cache_root = Path(os.getenv("STEM_CACHE_PATH", "./stem-cache")).resolve()
    output_dir = cache_root / _cache_key(input_path, model)
    output_dir.mkdir(parents=True, exist_ok=True)

    existing = _find_stems(output_dir)
    if existing.instrumental:
        return existing

    command = [
        "audio-separator",
        input_path,
        "--model_filename",
        model,
        "--output_dir",
        str(output_dir),
        "--output_format",
        "FLAC",
        "--normalization",
        os.getenv("STEM_NORMALIZATION", "0.95"),
    ]

    extra = [value.strip() for value in os.getenv("STEM_EXTRA_MODELS", "").split(",") if value.strip()]
    if extra:
        command.extend(["--extra_models", *extra])
    if os.getenv("STEM_AUTOCAST", "true").lower() in {"1", "true", "yes", "on"}:
        command.append("--use_autocast")
    if os.getenv("STEM_TORCH_COMPILE", "false").lower() in {"1", "true", "yes", "on"}:
        command.append("--use_torch_compile")

    subprocess.run(command, check=True)
    result = _find_stems(output_dir)
    return result if result.instrumental else None
