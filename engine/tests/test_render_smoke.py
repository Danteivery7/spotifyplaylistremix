from __future__ import annotations

import subprocess

import numpy as np
import soundfile as sf

from app.mastering import master_audio
from app.models import MixClip, RemixSettings
from app.renderer import render_mix


def _write_tone(path, frequency: float, seconds: float = 6.0, sample_rate: int = 48000) -> None:
    t = np.arange(int(sample_rate * seconds), dtype=np.float64) / sample_rate
    envelope = 0.72 + 0.28 * np.sin(2 * np.pi * 2 * t)
    audio = 0.14 * np.sin(2 * np.pi * frequency * t) * envelope
    sf.write(path, audio, sample_rate)


def test_audio_render_and_mastering_smoke(tmp_path):
    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    _write_tone(first, 220.0)
    _write_tone(second, 330.0)

    clips = [
        MixClip(
            spotify_id="a",
            title="A",
            artists=["Artist"],
            file_path=str(first),
            start_seconds=0,
            duration_seconds=5.5,
            transition_seconds=1.0,
            bpm=120,
            key="C major",
            transition_type="phrase_blend",
            compatibility_score=0.85,
        ),
        MixClip(
            spotify_id="b",
            title="B",
            artists=["Artist"],
            file_path=str(second),
            start_seconds=0,
            duration_seconds=5.5,
            transition_seconds=0,
            bpm=120,
            key="G major",
            transition_type="outro",
            compatibility_score=1.0,
        ),
    ]

    raw = render_mix(clips, str(tmp_path / "mix.wav"))
    mastered, report = master_audio(
        raw,
        str(tmp_path / "mix.m4a"),
        RemixSettings(mastering_target_lufs=-14, max_true_peak_db=-1),
    )

    assert (tmp_path / "mix.wav").is_file()
    assert (tmp_path / "mix.m4a").is_file()
    assert mastered.endswith(".m4a")
    assert report.output_lufs is not None
    assert abs(report.output_lufs - report.target_lufs) < 0.75

    duration = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", mastered,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert 9.5 <= float(duration.stdout.strip()) <= 10.5
