from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .models import MasteringReport, RemixSettings


def _run_capture(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, text=True, capture_output=True)


def _parse_loudnorm(stderr: str) -> dict[str, str] | None:
    blocks = re.findall(r"\{\s*\"input_i\".*?\}", stderr, flags=re.DOTALL)
    if not blocks:
        return None
    try:
        return json.loads(blocks[-1])
    except json.JSONDecodeError:
        return None


def _as_float(value: object) -> float | None:
    try:
        number = float(str(value))
        if number in {float("inf"), float("-inf")}:
            return None
        return number
    except (TypeError, ValueError):
        return None


def master_audio(input_path: str, output_path: str, settings: RemixSettings) -> tuple[str, MasteringReport]:
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    target_i = settings.mastering_target_lufs
    target_tp = settings.max_true_peak_db
    target_lra = 9.0
    pre_filter = "highpass=f=24"

    first_filter = (
        f"{pre_filter},"
        f"loudnorm=I={target_i}:LRA={target_lra}:TP={target_tp}:print_format=json"
    )
    first = _run_capture([
        "ffmpeg", "-y", "-hide_banner", "-nostats", "-i", input_path,
        "-af", first_filter, "-f", "null", "-"
    ])
    measured = _parse_loudnorm(first.stderr)

    if measured:
        second_filter = (
            f"{pre_filter},"
            f"loudnorm=I={target_i}:LRA={target_lra}:TP={target_tp}:"
            f"measured_I={measured['input_i']}:"
            f"measured_LRA={measured['input_lra']}:"
            f"measured_TP={measured['input_tp']}:"
            f"measured_thresh={measured['input_thresh']}:"
            f"offset={measured['target_offset']}:"
            "linear=true:print_format=json,"
            "aresample=48000"
        )
    else:
        second_filter = (
            f"{pre_filter},"
            f"loudnorm=I={target_i}:LRA={target_lra}:TP={target_tp}:print_format=json,"
            "aresample=48000"
        )

    second = _run_capture([
        "ffmpeg", "-y", "-hide_banner", "-nostats", "-i", input_path,
        "-af", second_filter,
        "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
        "-movflags", "+faststart", str(out),
    ])
    final_stats = _parse_loudnorm(second.stderr) or {}

    report = MasteringReport(
        target_lufs=target_i,
        target_true_peak_db=target_tp,
        input_lufs=_as_float(measured.get("input_i")) if measured else None,
        output_lufs=_as_float(final_stats.get("output_i")),
        input_true_peak_db=_as_float(measured.get("input_tp")) if measured else None,
        output_true_peak_db=_as_float(final_stats.get("output_tp")),
        loudness_range=_as_float(final_stats.get("output_lra") or (measured or {}).get("input_lra")),
    )
    return str(out), report
