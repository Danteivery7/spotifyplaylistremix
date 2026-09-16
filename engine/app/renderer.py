from __future__ import annotations

import hashlib
import subprocess
import tempfile
import urllib.request
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


def _escape_drawtext(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace("%", "\\%")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def _adjusted_duration(clip: MixClip) -> float:
    ratio = clip.tempo_ratio if clip.tempo_ratio > 0 else 1.0
    return clip.duration_seconds / ratio


def _visual_durations(clips: list[MixClip]) -> list[float]:
    if not clips:
        return []

    starts = [0.0]
    for index in range(1, len(clips)):
        previous = clips[index - 1]
        starts.append(
            starts[-1]
            + _adjusted_duration(previous)
            - max(0.0, previous.transition_seconds)
        )

    boundaries = [0.0]
    for index in range(len(clips) - 1):
        transition = max(0.0, clips[index].transition_seconds)
        boundaries.append(starts[index + 1] + transition / 2.0)
    boundaries.append(starts[-1] + _adjusted_duration(clips[-1]))

    durations: list[float] = []
    for index in range(len(clips)):
        durations.append(max(0.25, boundaries[index + 1] - boundaries[index]))
    return durations


def _download_artwork(url: str | None, directory: Path, index: int) -> Path | None:
    if not url or not url.startswith(("https://", "http://")):
        return None

    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    target = directory / f"art-{index:03d}-{digest}.jpg"
    if target.exists():
        return target

    request = urllib.request.Request(url, headers={"User-Agent": "PlaylistRemixStudio/0.4"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            content_type = (response.headers.get("content-type") or "").lower()
            if "png" in content_type:
                target = target.with_suffix(".png")
            data = response.read(8 * 1024 * 1024 + 1)
            if not data or len(data) > 8 * 1024 * 1024:
                return None
            target.write_bytes(data)
            return target
    except Exception:
        return None


def render_video(audio_path: str, output_path: str, title: str, clips: list[MixClip] | None = None) -> str:
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    safe_title = _escape_drawtext(title)
    clip_list = clips or []

    if not clip_list:
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

    durations = _visual_durations(clip_list)
    with tempfile.TemporaryDirectory(prefix="remix-art-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        artwork = [_download_artwork(clip.image_url, temp_dir, index) for index, clip in enumerate(clip_list)]

        command: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
        for index, duration in enumerate(durations):
            art = artwork[index]
            if art:
                command.extend(["-loop", "1", "-t", f"{duration:.3f}", "-i", str(art)])
            else:
                command.extend([
                    "-f", "lavfi",
                    "-t", f"{duration:.3f}",
                    "-i", "color=c=0x101510:s=1080x1080:r=30",
                ])

        audio_index = len(clip_list)
        command.extend(["-i", audio_path])

        filters: list[str] = []
        segment_labels: list[str] = []
        for index, clip in enumerate(clip_list):
            duration = durations[index]
            song = _escape_drawtext(clip.title)
            artist = _escape_drawtext(", ".join(clip.artists))
            filters.append(f"[{index}:v]split=2[bgsrc{index}][artsrc{index}]")
            filters.append(
                f"[bgsrc{index}]scale=1920:1080:force_original_aspect_ratio=increase,"
                f"crop=1920:1080,boxblur=28:4,eq=brightness=-0.34:saturation=0.82[bg{index}]"
            )
            filters.append(
                f"[artsrc{index}]scale=650:650:force_original_aspect_ratio=decrease,"
                f"pad=650:650:(ow-iw)/2:(oh-ih)/2:color=0x080a08[art{index}]"
            )
            filters.append(
                f"[bg{index}][art{index}]overlay=(W-w)/2:125,"
                f"drawtext=text='{song}':fontcolor=white:fontsize=48:"
                f"x=(w-text_w)/2:y=815,"
                f"drawtext=text='{artist}':fontcolor=0xc7cec2:fontsize=28:"
                f"x=(w-text_w)/2:y=882,"
                f"drawtext=text='{safe_title}':fontcolor=0x8f998c:fontsize=22:"
                f"x=(w-text_w)/2:y=930,"
                f"fps=30,format=yuv420p,trim=duration={duration:.3f},setpts=PTS-STARTPTS[seg{index}]"
            )
            segment_labels.append(f"[seg{index}]")

        filters.append(
            f"{''.join(segment_labels)}concat=n={len(segment_labels)}:v=1:a=0[visual]"
        )
        filters.append(
            f"[{audio_index}:a]asplit=2[aout][wave]"
        )
        filters.append(
            "[wave]showwaves=s=1500x120:mode=cline:rate=30:colors=0x1ed760,format=rgba[wv]"
        )
        filters.append(
            "[visual][wv]overlay=(W-w)/2:H-135[v]"
        )

        command.extend([
            "-filter_complex", ";".join(filters),
            "-map", "[v]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", str(out),
        ])
        _run(command)

    return str(out)
