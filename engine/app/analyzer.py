from __future__ import annotations

import math
from pathlib import Path

import librosa
import numpy as np

from .models import Analysis, ResolvedTrack

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _estimate_key(chroma: np.ndarray) -> tuple[int, str]:
    profile = np.mean(chroma, axis=1)
    best_score = -math.inf
    best_key = 0
    best_mode = "major"
    for tonic in range(12):
        major = np.roll(MAJOR_PROFILE, tonic)
        minor = np.roll(MINOR_PROFILE, tonic)
        major_score = float(np.corrcoef(profile, major)[0, 1])
        minor_score = float(np.corrcoef(profile, minor)[0, 1])
        if major_score > best_score:
            best_score, best_key, best_mode = major_score, tonic, "major"
        if minor_score > best_score:
            best_score, best_key, best_mode = minor_score, tonic, "minor"
    return best_key, best_mode


def analyze_file(path: str) -> Analysis:
    y, sr = librosa.load(path, sr=22050, mono=True)
    if y.size == 0:
        raise ValueError(f"No audio samples found in {path}")
    duration = float(librosa.get_duration(y=y, sr=sr))
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr, onset_envelope=onset_env)
    bpm = float(np.asarray(tempo).reshape(-1)[0])
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key_index, mode = _estimate_key(chroma)
    rms = librosa.feature.rms(y=y)[0]
    energy = float(np.clip(np.mean(rms) * 8.0, 0.0, 1.0))
    onset_strength = float(np.clip(np.mean(onset_env) / 5.0, 0.0, 1.0))
    return Analysis(bpm=round(bpm, 2), key=f"{KEY_NAMES[key_index]} {mode}", key_index=key_index, mode=mode, energy=round(energy, 4), duration_seconds=round(duration, 3), onset_strength=round(onset_strength, 4))


def analyze_tracks(tracks: list[ResolvedTrack]) -> list[ResolvedTrack]:
    output: list[ResolvedTrack] = []
    for track in tracks:
        if not Path(track.file_path).exists():
            raise FileNotFoundError(track.file_path)
        output.append(track.model_copy(update={"analysis": analyze_file(track.file_path)}))
    return output
