from __future__ import annotations

import math
from statistics import median

from .models import MixClip, RemixSettings, ResolvedTrack, Section


_MAJOR_CAMELOT = {0: 8, 1: 3, 2: 10, 3: 5, 4: 12, 5: 7, 6: 2, 7: 9, 8: 4, 9: 11, 10: 6, 11: 1}
_MINOR_CAMELOT = {0: 5, 1: 12, 2: 7, 3: 2, 4: 9, 5: 4, 6: 11, 7: 6, 8: 1, 9: 8, 10: 3, 11: 10}


def _camelot(key_index: int, mode: str) -> tuple[int, str]:
    if mode == "minor":
        return _MINOR_CAMELOT[key_index % 12], "A"
    return _MAJOR_CAMELOT[key_index % 12], "B"


def _wheel_distance(a: int, b: int) -> int:
    raw = abs(a - b)
    return min(raw, 12 - raw)


def harmonic_compatibility(a: ResolvedTrack, b: ResolvedTrack) -> float:
    assert a.analysis and b.analysis
    an, al = _camelot(a.analysis.key_index, a.analysis.mode)
    bn, bl = _camelot(b.analysis.key_index, b.analysis.mode)
    if an == bn and al == bl:
        base = 1.0
    elif an == bn and al != bl:
        base = 0.98
    elif al == bl and _wheel_distance(an, bn) == 1:
        base = 0.93
    elif al != bl and _wheel_distance(an, bn) == 1:
        base = 0.84
    else:
        base = max(0.20, 0.78 - 0.12 * _wheel_distance(an, bn))
        if al != bl:
            base -= 0.05

    confidence = min(a.analysis.key_confidence or 0.65, b.analysis.key_confidence or 0.65)
    return float(max(0.0, min(1.0, base * (0.78 + 0.22 * confidence))))


def _equivalent_bpm(source: float, reference: float) -> float:
    if source <= 0 or reference <= 0:
        return source
    return min((source, source * 2.0, source / 2.0), key=lambda candidate: abs(candidate - reference))


def _tempo_distance(a: float, b: float) -> float:
    if a <= 0 or b <= 0:
        return 1.0
    equivalent = _equivalent_bpm(b, a)
    return abs(a - equivalent) / max(a, equivalent, 1.0)


def _tempo_ratio(incoming_bpm: float, reference_bpm: float) -> float:
    equivalent = _equivalent_bpm(incoming_bpm, reference_bpm)
    if equivalent <= 0:
        return 1.0
    ratio = reference_bpm / equivalent
    return round(ratio, 5) if 0.96 <= ratio <= 1.04 else 1.0


def compatibility(a: ResolvedTrack, b: ResolvedTrack) -> float:
    assert a.analysis and b.analysis
    tempo = 1.0 - min(1.0, _tempo_distance(a.analysis.bpm, b.analysis.bpm) * 5.0)
    key = harmonic_compatibility(a, b)
    energy = 1.0 - min(1.0, abs(a.analysis.energy - b.analysis.energy) * 1.35)
    rhythmic = min(a.analysis.tempo_stability or 0.65, b.analysis.tempo_stability or 0.65)
    score = tempo * 0.42 + key * 0.34 + energy * 0.16 + rhythmic * 0.08
    return round(float(max(0.0, min(1.0, score))), 5)


def smart_order(tracks: list[ResolvedTrack]) -> list[ResolvedTrack]:
    if len(tracks) < 3:
        return tracks[:]

    n = len(tracks)
    start_indices = sorted(
        range(n),
        key=lambda i: tracks[i].analysis.energy if tracks[i].analysis else 0.0,
    )[: min(6, n)]

    beams: list[tuple[float, tuple[int, ...], tuple[int, ...]]] = []
    all_indices = tuple(range(n))
    for start in start_indices:
        remaining = tuple(i for i in all_indices if i != start)
        beams.append((0.0, (start,), remaining))

    width = 28
    branch = 10
    for depth in range(1, n):
        expanded: list[tuple[float, tuple[int, ...], tuple[int, ...]]] = []
        progress = depth / max(1, n - 1)
        target_energy = 0.34 + 0.52 * math.sin(math.pi * progress)
        for score, order, remaining in beams:
            previous = tracks[order[-1]]
            candidates = sorted(
                remaining,
                key=lambda idx: compatibility(previous, tracks[idx]),
                reverse=True,
            )[:branch]
            for idx in candidates:
                candidate = tracks[idx]
                musical = compatibility(previous, candidate)
                energy_value = candidate.analysis.energy if candidate.analysis else 0.5
                arc = 1.0 - min(1.0, abs(energy_value - target_energy))
                new_score = score + musical + 0.10 * arc
                new_remaining = tuple(x for x in remaining if x != idx)
                expanded.append((new_score, order + (idx,), new_remaining))
        if not expanded:
            break
        expanded.sort(key=lambda item: item[0], reverse=True)
        beams = expanded[:width]

    if not beams or len(beams[0][1]) != n:
        return tracks[:]
    best = max(beams, key=lambda item: item[0])
    return [tracks[index] for index in best[1]]


def _section_at(sections: list[Section], time_seconds: float) -> str:
    for section in sections:
        if section.start_seconds <= time_seconds < section.end_seconds:
            return section.label
    return sections[-1].label if sections else ""


def _window_contains_highlight(sections: list[Section], start: float, end: float) -> bool:
    for section in sections:
        if section.label != "chorus_drop":
            continue
        overlap = max(0.0, min(end, section.end_seconds) - max(start, section.start_seconds))
        if overlap >= 6.0:
            return True
    return False


def choose_window(track: ResolvedTrack, settings: RemixSettings) -> tuple[float, float, str]:
    assert track.analysis
    analysis = track.analysis
    duration = analysis.duration_seconds
    max_window = min(settings.target_max_seconds, max(45.0, duration - 10.0))
    min_window = min(settings.target_min_seconds, max_window)
    target = min(max_window, max(min_window, duration * 0.58))

    if not settings.phrase_alignment or len(analysis.phrase_boundaries) < 2:
        safe_tail = 10.0
        start = min(max(0.0, duration * 0.06), max(0.0, duration - target - safe_tail))
        return round(start, 3), round(min(target, duration - start), 3), _section_at(analysis.sections, start)

    phrases = sorted(set(float(x) for x in analysis.phrase_boundaries if 0.0 <= x <= duration))
    if 0.0 not in phrases:
        phrases.insert(0, 0.0)
    if duration not in phrases:
        phrases.append(duration)

    starts = [p for p in phrases if p <= duration * 0.34 and p <= duration - min_window]
    candidates: list[tuple[float, float, float]] = []
    for start in starts:
        for end in phrases:
            length = end - start
            if length < min_window - 1.0 or length > max_window + 1.0:
                continue
            duration_score = 1.0 - min(1.0, abs(length - target) / max(1.0, target))
            early_score = 1.0 - min(1.0, start / max(1.0, duration * 0.34))
            highlight = 1.0 if _window_contains_highlight(analysis.sections, start, end) else 0.0
            ending_section = _section_at(analysis.sections, max(start, end - 0.1))
            clean_end = 1.0 if ending_section in {"chorus_drop", "verse", "breakdown", "outro"} else 0.7
            score = duration_score * 0.48 + early_score * 0.20 + highlight * 0.24 + clean_end * 0.08
            candidates.append((score, start, length))

    if not candidates:
        start = min(max(0.0, duration * 0.06), max(0.0, duration - target - 10.0))
        return round(start, 3), round(min(target, duration - start), 3), _section_at(analysis.sections, start)

    _, start, length = max(candidates, key=lambda item: item[0])
    return round(start, 3), round(length, 3), _section_at(analysis.sections, start)


def _transition_plan(a: ResolvedTrack, b: ResolvedTrack, settings: RemixSettings) -> tuple[str, float, float, str]:
    assert a.analysis and b.analysis
    score = compatibility(a, b)
    tempo_gap = _tempo_distance(a.analysis.bpm, b.analysis.bpm)
    harmonic = harmonic_compatibility(a, b)

    if settings.stem_transitions and score >= 0.78 and harmonic >= 0.78:
        kind = "stem_blend"
        transition = min(20.0, settings.transition_seconds + 5.0)
        note = "Instrumental-first vocal-safe blend on a phrase boundary"
    elif score >= 0.80:
        kind = "harmonic_phrase_blend"
        transition = min(18.0, settings.transition_seconds + 3.0)
        note = "Long phrase-aligned harmonic blend"
    elif tempo_gap <= 0.075:
        kind = "phrase_blend"
        transition = settings.transition_seconds
        note = "Beat- and phrase-aligned equal-power blend"
    elif score >= 0.52:
        kind = "filter_blend"
        transition = max(7.0, settings.transition_seconds - 3.0)
        note = "Shorter tonal blend to hide a larger musical gap"
    else:
        kind = "short_blend"
        transition = max(5.0, settings.transition_seconds - 6.0)
        note = "Short clean handoff because the tracks are intentionally dissimilar"

    return kind, round(float(transition), 3), score, note


def plan_mix(tracks: list[ResolvedTrack], settings: RemixSettings) -> list[MixClip]:
    if any(track.analysis is None for track in tracks):
        raise ValueError("All tracks must be analyzed before planning.")

    ordered = smart_order(tracks) if settings.smart_order else tracks[:]
    clips: list[MixClip] = []
    rms_values = [track.analysis.rms_dbfs for track in ordered if track.analysis]
    target_rms = median(rms_values) if rms_values else -18.0

    for index, track in enumerate(ordered):
        assert track.analysis
        start, duration, section_label = choose_window(track, settings)
        incoming_ratio = 1.0
        if index > 0 and ordered[index - 1].analysis:
            incoming_ratio = _tempo_ratio(track.analysis.bpm, ordered[index - 1].analysis.bpm)

        if index == len(ordered) - 1:
            transition_type = "outro"
            transition = 0.0
            score = 1.0
            note = "Final track"
        else:
            transition_type, transition, score, note = _transition_plan(track, ordered[index + 1], settings)

        clips.append(
            MixClip(
                spotify_id=track.spotify_id,
                title=track.title,
                artists=track.artists,
                file_path=track.file_path,
                start_seconds=start,
                duration_seconds=duration,
                transition_seconds=transition,
                bpm=track.analysis.bpm,
                key=track.analysis.key,
                transition_type=transition_type,
                compatibility_score=score,
                tempo_ratio=incoming_ratio,
                gain_db=round(max(-5.0, min(5.0, target_rms - track.analysis.rms_dbfs)), 3),
                use_instrumental_intro=False,
                section_label=section_label,
                transition_note=note,
            )
        )

    for index in range(len(clips) - 1):
        if clips[index].transition_type == "stem_blend":
            clips[index + 1] = clips[index + 1].model_copy(update={"use_instrumental_intro": True})

    return clips
