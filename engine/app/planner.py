from __future__ import annotations

from .models import MixClip, RemixSettings, ResolvedTrack


def _tempo_distance(a: float, b: float) -> float:
    candidates = [abs(a - b), abs(a * 2 - b), abs(a - b * 2)]
    return min(candidates) / max(a, b, 1.0)


def _key_distance(a: int, b: int) -> float:
    raw = abs(a - b) % 12
    circle = min(raw, 12 - raw)
    return circle / 6.0


def compatibility(a: ResolvedTrack, b: ResolvedTrack) -> float:
    assert a.analysis and b.analysis
    tempo = 1.0 - min(1.0, _tempo_distance(a.analysis.bpm, b.analysis.bpm) * 4)
    key = 1.0 - _key_distance(a.analysis.key_index, b.analysis.key_index)
    energy = 1.0 - abs(a.analysis.energy - b.analysis.energy)
    return tempo * 0.50 + key * 0.32 + energy * 0.18


def smart_order(tracks: list[ResolvedTrack]) -> list[ResolvedTrack]:
    if len(tracks) < 3:
        return tracks[:]
    remaining = tracks[:]
    current = min(remaining, key=lambda t: (t.analysis.energy if t.analysis else 0.0))
    ordered = [current]
    remaining.remove(current)
    while remaining:
        current = max(remaining, key=lambda t: compatibility(ordered[-1], t))
        ordered.append(current)
        remaining.remove(current)
    return ordered


def choose_window(track: ResolvedTrack, settings: RemixSettings) -> tuple[float, float]:
    assert track.analysis
    duration = track.analysis.duration_seconds
    max_window = min(settings.target_max_seconds, max(45.0, duration - 18.0))
    target = min(max_window, max(settings.target_min_seconds, duration * 0.58))
    safe_tail = 12.0
    start = min(max(0.0, duration * 0.08), max(0.0, duration - target - safe_tail))
    return round(start, 3), round(min(target, duration - start), 3)


def transition_type(a: ResolvedTrack, b: ResolvedTrack) -> str:
    assert a.analysis and b.analysis
    bpm_gap = _tempo_distance(a.analysis.bpm, b.analysis.bpm)
    key_gap = _key_distance(a.analysis.key_index, b.analysis.key_index)
    if bpm_gap < 0.035 and key_gap <= 0.34:
        return "long_blend"
    if bpm_gap < 0.07:
        return "blend"
    return "short_blend"


def plan_mix(tracks: list[ResolvedTrack], settings: RemixSettings) -> list[MixClip]:
    if any(track.analysis is None for track in tracks):
        raise ValueError("All tracks must be analyzed before planning.")
    ordered = smart_order(tracks) if settings.smart_order else tracks[:]
    clips: list[MixClip] = []
    for index, track in enumerate(ordered):
        start, duration = choose_window(track, settings)
        t_type = "outro" if index == len(ordered) - 1 else transition_type(track, ordered[index + 1])
        transition = 0.0 if index == len(ordered) - 1 else settings.transition_seconds
        if t_type == "long_blend": transition = min(18.0, transition + 4.0)
        if t_type == "short_blend": transition = max(6.0, transition - 4.0)
        clips.append(MixClip(spotify_id=track.spotify_id, title=track.title, artists=track.artists, file_path=track.file_path, start_seconds=start, duration_seconds=duration, transition_seconds=round(transition, 3), bpm=track.analysis.bpm, key=track.analysis.key, transition_type=t_type))
    return clips
