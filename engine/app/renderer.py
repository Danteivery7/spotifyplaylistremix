from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from .mastering import master_audio
from .models import MixClip, RemixSettings
from .separator import separate_vocals_instrumental


def _run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def _tempo_filter(ratio: float) -> str:
    if abs(ratio - 1.0) < 0.001:
        return ""
    return f",atempo={ratio:.5f}"


def _gain_filter(gain_db: float) -> str:
    if abs(gain_db) < 0.05:
        return ""
    return f",volume={gain_db:.3f}dB"


def render_mix(clips: list[MixClip], output_path: str) -> str:
    if not clips:
        raise ValueError("No clips to render.")

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    command: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    original_inputs: list[int] = []
    instrumental_inputs: dict[int, int] = {}
    input_index = 0

    for index, clip in enumerate(clips):
        command.extend([
            "-ss", str(clip.start_seconds),
            "-t", str(clip.duration_seconds),
            "-i", clip.file_path,
        ])
        original_inputs.append(input_index)
        input_index += 1

        if clip.use_instrumental_intro:
            try:
                bundle = separate_vocals_instrumental(clip.file_path)
            except (subprocess.CalledProcessError, FileNotFoundError, RuntimeError):
                bundle = None
            if bundle and bundle.instrumental:
                command.extend([
                    "-ss", str(clip.start_seconds),
                    "-t", str(clip.duration_seconds),
                    "-i", bundle.instrumental,
                ])
                instrumental_inputs[index] = input_index
                input_index += 1

    filters: list[str] = []
    for index, clip in enumerate(clips):
        source = original_inputs[index]
        chain = (
            f"[{source}:a]"
            "aresample=48000,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo"
            f"{_tempo_filter(clip.tempo_ratio)}"
            f"{_gain_filter(clip.gain_db)},"
            "asetpts=PTS-STARTPTS"
            f"[orig{index}]"
        )
        filters.append(chain)

        stem_source = instrumental_inputs.get(index)
        if stem_source is None or index == 0:
            filters.append(f"[orig{index}]anull[a{index}]")
            continue

        transition = max(0.5, clips[index - 1].transition_seconds)
        stem_chain = (
            f"[{stem_source}:a]"
            "aresample=48000,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo"
            f"{_tempo_filter(clip.tempo_ratio)}"
            f"{_gain_filter(clip.gain_db)},"
            "asetpts=PTS-STARTPTS"
            f"[inst{index}]"
        )
        filters.append(stem_chain)

        half = 0.30
        filters.append(
            f"[inst{index}]atrim=start=0:end={transition + half:.3f},asetpts=PTS-STARTPTS[head{index}]"
        )
        filters.append(
            f"[orig{index}]atrim=start={max(0.0, transition - half):.3f},asetpts=PTS-STARTPTS[body{index}]"
        )
        filters.append(
            f"[head{index}][body{index}]acrossfade=d={half * 2:.3f}:c1=qsin:c2=qsin[a{index}]"
        )

    current = "a0"
    for index in range(1, len(clips)):
        previous = clips[index - 1]
        duration = max(0.05, previous.transition_seconds)
        next_label = f"mix{index}"
        curve = "tri" if previous.transition_type == "short_blend" else "qsin"
        filters.append(
            f"[{current}][a{index}]acrossfade=d={duration:.3f}:c1={curve}:c2={curve}[{next_label}]"
        )
        current = next_label

    command.extend([
        "-filter_complex", ";".join(filters),
        "-map", f"[{current}]",
        "-c:a", "pcm_f32le",
        "-ar", "48000",
        str(out),
    ])
    _run(command)
    return str(out)


def render_transition_preview(
    clips: list[MixClip],
    transition_index: int,
    output_path: str,
    settings: RemixSettings,
) -> str:
    if transition_index < 0 or transition_index >= len(clips) - 1:
        raise IndexError("Transition index is out of range.")

    outgoing = clips[transition_index]
    incoming = clips[transition_index + 1]
    transition = max(0.5, outgoing.transition_seconds)
    desired = settings.preview_seconds
    part = max(transition + 4.0, (desired + transition) / 2.0)
    outgoing_part = min(outgoing.duration_seconds, part)
    incoming_part = min(incoming.duration_seconds, part)

    pair = [
        outgoing.model_copy(update={
            "start_seconds": round(outgoing.start_seconds + outgoing.duration_seconds - outgoing_part, 3),
            "duration_seconds": round(outgoing_part, 3),
        }),
        incoming.model_copy(update={
            "duration_seconds": round(incoming_part, 3),
            "transition_seconds": 0.0,
            "transition_type": "outro",
        }),
    ]

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="remix-preview-") as temp_dir:
        raw = Path(temp_dir) / "preview.wav"
        render_mix(pair, str(raw))
        mastered, _ = master_audio(str(raw), str(out), settings)
    return mastered


def render_video(audio_path: str, output_path: str, title: str) -> str:
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    safe_title = title.replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:")

    filter_complex = (
        "[1:a]asplit=2[aout][wave];"
        "[wave]showwaves=s=1500x260:mode=cline:rate=30:colors=0x1ed760,format=rgba[wv];"
        "[0:v][wv]overlay=(W-w)/2:H*0.62[base];"
        f"[base]drawtext=text='{safe_title}':fontcolor=white:fontsize=58:"
        "x=(w-text_w)/2:y=(h-text_h)/2-90,"
        "drawtext=text='Playlist Remix':fontcolor=0x8f998c:fontsize=27:"
        "x=(w-text_w)/2:y=(h-text_h)/2-15[v]"
    )

    _run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=0x080a08:s=1920x1080:r=30",
        "-i", audio_path,
        "-filter_complex", filter_complex,
        "-map", "[v]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", str(out),
    ])
    return str(out)
