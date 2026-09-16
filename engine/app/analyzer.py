from __future__ import annotations

import math
from pathlib import Path

import librosa
import numpy as np

from .models import Analysis, ResolvedTrack, Section

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _safe_corr(a: np.ndarray, b: np.ndarray) -> float:
    if np.std(a) < 1e-9 or np.std(b) < 1e-9:
        return 0.0
    return float(np.nan_to_num(np.corrcoef(a, b)[0, 1]))


def _estimate_key(chroma: np.ndarray) -> tuple[int, str, float]:
    profile = np.mean(chroma, axis=1)
    scored: list[tuple[float, int, str]] = []
    for tonic in range(12):
        scored.append((_safe_corr(profile, np.roll(MAJOR_PROFILE, tonic)), tonic, "major"))
        scored.append((_safe_corr(profile, np.roll(MINOR_PROFILE, tonic)), tonic, "minor"))
    scored.sort(reverse=True, key=lambda item: item[0])
    best_score, best_key, best_mode = scored[0]
    runner_up = scored[1][0] if len(scored) > 1 else -1.0
    confidence = float(np.clip((best_score - runner_up + 0.15) / 0.5, 0.0, 1.0))
    return best_key, best_mode, confidence


def _bar_grid(beat_frames: np.ndarray, onset_env: np.ndarray, sr: int, hop_length: int) -> tuple[list[float], int]:
    if len(beat_frames) < 4:
        beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
        return [float(x) for x in beat_times], 0

    strengths = onset_env[np.clip(beat_frames, 0, len(onset_env) - 1)]
    scores = []
    for offset in range(4):
        values = strengths[offset::4]
        scores.append(float(np.mean(values)) if len(values) else 0.0)
    bar_offset = int(np.argmax(scores))
    bars = beat_frames[bar_offset::4]
    times = librosa.frames_to_time(bars, sr=sr, hop_length=hop_length)
    return [round(float(x), 3) for x in times], bar_offset


def _dedupe_boundaries(values: list[float], minimum_gap: float = 1.5) -> list[float]:
    out: list[float] = []
    for value in sorted(values):
        value = round(float(value), 3)
        if not out or value - out[-1] >= minimum_gap:
            out.append(value)
    return out


def _structure_boundaries(
    y: np.ndarray,
    harmonic: np.ndarray,
    sr: int,
    beat_frames: np.ndarray,
    beat_times: np.ndarray,
    bar_times: list[float],
    duration: float,
) -> list[float]:
    if len(beat_frames) < 12:
        return _dedupe_boundaries([0.0, duration])

    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)

    usable = beat_frames[(beat_frames < chroma.shape[1]) & (beat_frames < mfcc.shape[1])]
    if len(usable) < 8:
        return _dedupe_boundaries([0.0, duration])

    chroma_b = chroma[:, usable]
    mfcc_b = mfcc[:, usable]
    mfcc_b = (mfcc_b - np.mean(mfcc_b, axis=1, keepdims=True)) / (np.std(mfcc_b, axis=1, keepdims=True) + 1e-6)
    features = np.vstack([chroma_b, 0.35 * mfcc_b])

    section_count = int(np.clip(round(duration / 28.0), 4, min(14, max(4, len(usable) // 8))))
    section_count = min(section_count, max(2, features.shape[1] - 1))
    if section_count < 2:
        return _dedupe_boundaries([0.0, duration])

    try:
        beat_boundary_indices = librosa.segment.agglomerative(features, section_count)
    except Exception:
        beat_boundary_indices = np.linspace(0, len(usable) - 1, section_count, dtype=int)

    usable_times = librosa.frames_to_time(usable, sr=sr)
    raw = [0.0]
    for index in beat_boundary_indices:
        if 0 <= int(index) < len(usable_times):
            raw.append(float(usable_times[int(index)]))
    raw.append(duration)

    if bar_times:
        snapped = [0.0]
        bars = np.asarray(bar_times, dtype=float)
        for value in raw[1:-1]:
            snapped.append(float(bars[int(np.argmin(np.abs(bars - value)))]))
        snapped.append(duration)
        raw = snapped

    return _dedupe_boundaries(raw, minimum_gap=4.0)


def _phrase_boundaries(structure: list[float], bar_times: list[float], duration: float) -> list[float]:
    values = list(structure)
    values.extend(bar_times[::8])
    values.extend([0.0, duration])
    return _dedupe_boundaries(values, minimum_gap=3.0)


def _classify_sections(
    rms: np.ndarray,
    onset_env: np.ndarray,
    sr: int,
    hop_length: int,
    boundaries: list[float],
) -> list[Section]:
    if len(boundaries) < 2:
        return []

    energies: list[float] = []
    onsets: list[float] = []
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        f0 = max(0, int(librosa.time_to_frames(start, sr=sr, hop_length=hop_length)))
        f1 = max(f0 + 1, int(librosa.time_to_frames(end, sr=sr, hop_length=hop_length)))
        energies.append(float(np.mean(rms[f0:min(f1, len(rms))])) if f0 < len(rms) else 0.0)
        onsets.append(float(np.mean(onset_env[f0:min(f1, len(onset_env))])) if f0 < len(onset_env) else 0.0)

    energy_q30 = float(np.quantile(energies, 0.30)) if energies else 0.0
    energy_q72 = float(np.quantile(energies, 0.72)) if energies else 0.0
    onset_med = float(np.median(onsets)) if onsets else 0.0
    max_energy = max(energies) if energies else 1.0

    sections: list[Section] = []
    previous = energies[0] if energies else 0.0
    for index, ((start, end), energy, onset) in enumerate(zip(zip(boundaries[:-1], boundaries[1:]), energies, onsets)):
        normalized_energy = float(np.clip(energy / (max_energy + 1e-9), 0.0, 1.0))
        if index == 0 and normalized_energy < 0.78:
            label = "intro"
        elif index == len(energies) - 1 and normalized_energy < 0.8:
            label = "outro"
        elif energy >= energy_q72 and onset >= onset_med * 0.85:
            label = "chorus_drop"
        elif energy <= energy_q30 and onset <= onset_med:
            label = "breakdown"
        elif previous > 0 and energy > previous * 1.14:
            label = "build"
        else:
            label = "verse"
        confidence = float(np.clip(0.55 + abs(normalized_energy - 0.5) * 0.5, 0.55, 0.95))
        sections.append(
            Section(
                start_seconds=round(float(start), 3),
                end_seconds=round(float(end), 3),
                label=label,
                energy=round(normalized_energy, 4),
                confidence=round(confidence, 4),
            )
        )
        previous = energy
    return sections


def analyze_file(path: str) -> Analysis:
    hop_length = 512
    y, sr = librosa.load(path, sr=22050, mono=True)
    if y.size == 0:
        raise ValueError(f"No audio samples found in {path}")

    duration = float(librosa.get_duration(y=y, sr=sr))
    harmonic, percussive = librosa.effects.hpss(y)
    onset_env = librosa.onset.onset_strength(y=percussive, sr=sr, hop_length=hop_length)
    tempo, beat_frames = librosa.beat.beat_track(
        y=percussive,
        sr=sr,
        onset_envelope=onset_env,
        hop_length=hop_length,
        trim=False,
    )
    bpm = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 0.0
    beat_frames = np.asarray(beat_frames, dtype=int)
    beat_times_np = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
    beat_times = [round(float(x), 3) for x in beat_times_np]

    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=hop_length)
    key_index, mode, key_confidence = _estimate_key(chroma)

    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    energy = float(np.clip(np.mean(rms) * 8.0, 0.0, 1.0))
    onset_strength = float(np.clip(np.mean(onset_env) / 5.0, 0.0, 1.0))

    local_tempo = librosa.feature.tempo(onset_envelope=onset_env, sr=sr, hop_length=hop_length, aggregate=None)
    local_tempo = np.asarray(local_tempo, dtype=float)
    valid_tempo = local_tempo[np.isfinite(local_tempo) & (local_tempo > 0)]
    if valid_tempo.size:
        tempo_stability = 1.0 - float(np.clip(np.std(valid_tempo) / (np.mean(valid_tempo) + 1e-9), 0.0, 1.0))
    else:
        tempo_stability = 0.0

    peak = float(np.max(np.abs(y))) if y.size else 0.0
    rms_total = float(np.sqrt(np.mean(np.square(y))) + 1e-12)
    crest_factor_db = 20.0 * math.log10(max(peak, 1e-12) / rms_total)

    bar_times, _ = _bar_grid(beat_frames, onset_env, sr, hop_length)
    structure = _structure_boundaries(y, harmonic, sr, beat_frames, beat_times_np, bar_times, duration)
    phrases = _phrase_boundaries(structure, bar_times, duration)
    sections = _classify_sections(rms, onset_env, sr, hop_length, structure)

    return Analysis(
        bpm=round(bpm, 2),
        key=f"{KEY_NAMES[key_index]} {mode}",
        key_index=key_index,
        mode=mode,
        energy=round(energy, 4),
        duration_seconds=round(duration, 3),
        onset_strength=round(onset_strength, 4),
        key_confidence=round(key_confidence, 4),
        tempo_stability=round(tempo_stability, 4),
        crest_factor_db=round(float(crest_factor_db), 3),
        rms_dbfs=round(20.0 * math.log10(max(rms_total, 1e-12)), 3),
        beat_times=beat_times,
        bar_times=bar_times,
        phrase_boundaries=phrases,
        sections=sections,
    )


def analyze_tracks(tracks: list[ResolvedTrack]) -> list[ResolvedTrack]:
    output: list[ResolvedTrack] = []
    for track in tracks:
        if not Path(track.file_path).exists():
            raise FileNotFoundError(track.file_path)
        output.append(track.model_copy(update={"analysis": analyze_file(track.file_path)}))
    return output
