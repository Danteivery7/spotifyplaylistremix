from __future__ import annotations

import os
import subprocess
from pathlib import Path


def stems_enabled() -> bool:
    return os.getenv("ENABLE_STEMS", "false").lower() in {"1", "true", "yes"}


def separate_vocals_instrumental(input_path: str, output_dir: str) -> list[str]:
    """Optional BS-RoFormer stem separation hook for authorized local audio."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    model = os.getenv("STEM_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
    subprocess.run([
        "audio-separator", input_path,
        "--model_filename", model,
        "--output_dir", output_dir,
        "--output_format", "FLAC",
    ], check=True)
    return [str(path) for path in Path(output_dir).glob("*.flac")]
