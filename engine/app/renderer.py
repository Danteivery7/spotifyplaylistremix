from __future__ import annotations

import subprocess
from pathlib import Path

from .models import MixClip


def _run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def render_audio(clips: list[MixClip], output_path: str) -> str:
    if not clips:
        raise ValueError("No clips to render.")
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    command: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    for clip in clips:
        command.extend(["-ss", str(clip.start_seconds), "-t", str(clip.duration_seconds), "-i", clip.file_path])

    filters: list[str] = []
    for index, _ in enumerate(clips):
        filters.append(f"[{index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{index}]")

    current = "a0"
    for index in range(1, len(clips)):
        duration = clips[index - 1].transition_seconds
        next_label = f"mix{index}"
        filters.append(f"[{current}][a{index}]acrossfade=d={duration}:c1=tri:c2=tri[{next_label}]")
        current = next_label

    command.extend(["-filter_complex", ";".join(filters), "-map", f"[{current}]", "-c:a", "aac", "-b:a", "320k", str(out)])
    _run(command)
    return str(out)


def render_video(audio_path: str, output_path: str, title: str) -> str:
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    safe_title = title.replace("'", "\\'").replace(":", "\\:")
    filter_text = (
        "drawtext=text='" + safe_title + "':fontcolor=white:fontsize=54:"
        "x=(w-text_w)/2:y=(h-text_h)/2-26,"
        "drawtext=text='Playlist Remix':fontcolor=0x8f998c:fontsize=26:"
        "x=(w-text_w)/2:y=(h-text_h)/2+54"
    )
    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=0x080a08:s=1920x1080:r=30",
        "-i", audio_path,
        "-vf", filter_text,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", str(out),
    ])
    return str(out)
