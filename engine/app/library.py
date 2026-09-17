from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from mutagen import File as MutagenFile

from .external_sources import materialize_external
from .models import PlaylistIn, ResolvedTrack, TrackIn

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}
VERSION_WORDS = {"live", "remix", "mix", "clean", "radio", "edit", "acoustic", "instrumental", "karaoke", "sped", "slowed"}


@dataclass(frozen=True)
class AudioCandidate:
    path: Path
    title: str = ""
    artists: tuple[str, ...] = ()
    duration_seconds: float = 0.0


def media_root() -> Path:
    root = Path(os.getenv("MEDIA_LIBRARY_PATH", "./media")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def media_roots() -> list[Path]:
    roots = [media_root()]
    raw_extra = os.getenv("EXTRA_MEDIA_PATHS", "")
    for raw in raw_extra.split(os.pathsep):
        raw = raw.strip()
        if not raw:
            continue
        path = Path(raw).expanduser().resolve()
        if path.exists() and path not in roots:
            roots.append(path)
    return roots


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"\([^)]*\)|\[[^]]*\]", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def _tag_values(tags, key: str) -> list[str]:
    if not tags:
        return []
    try:
        raw = tags.get(key, [])
    except Exception:
        return []
    if isinstance(raw, str):
        return [raw]
    return [str(value) for value in raw if value]


def inspect_audio(path: Path) -> AudioCandidate:
    title = ""
    artists: tuple[str, ...] = ()
    duration = 0.0
    try:
        audio = MutagenFile(str(path), easy=True)
        if audio is not None:
            title_values = _tag_values(audio.tags, "title")
            artist_values = _tag_values(audio.tags, "artist") or _tag_values(audio.tags, "albumartist")
            title = title_values[0] if title_values else ""
            artists = tuple(artist_values)
            duration = float(getattr(getattr(audio, "info", None), "length", 0.0) or 0.0)
    except Exception:
        pass
    return AudioCandidate(path=path, title=title, artists=artists, duration_seconds=duration)


def scan_library(root: Path | None = None) -> list[AudioCandidate]:
    roots = [root] if root is not None else media_roots()
    seen: set[Path] = set()
    candidates: list[AudioCandidate] = []
    for base in roots:
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            candidates.append(inspect_audio(resolved))
    return candidates


def _version_penalty(track: TrackIn, candidate_text: str) -> float:
    track_text = normalize(f"{track.name} {track.album}")
    penalty = 0.0
    for word in VERSION_WORDS:
        if word in candidate_text and word not in track_text:
            penalty += 0.055
    if track.explicit and ("clean" in candidate_text or "radio edit" in candidate_text):
        penalty += 0.18
    return min(0.28, penalty)


def score_file(track: TrackIn, candidate: AudioCandidate) -> float:
    expected_title = normalize(track.name)
    expected_artists = [normalize(artist) for artist in track.artists if artist]
    stem = normalize(candidate.path.stem)
    tagged_title = normalize(candidate.title)
    tagged_artists = [normalize(artist) for artist in candidate.artists if artist]
    candidate_text = " ".join(part for part in [stem, tagged_title, *tagged_artists] if part)

    title_score = 0.0
    if expected_title:
        title_score = max(
            SequenceMatcher(None, expected_title, tagged_title).ratio() if tagged_title else 0.0,
            SequenceMatcher(None, expected_title, stem).ratio(),
            0.96 if expected_title in candidate_text else 0.0,
        )

    artist_score = 0.0
    if expected_artists:
        for expected in expected_artists:
            artist_score = max(
                artist_score,
                max((SequenceMatcher(None, expected, actual).ratio() for actual in tagged_artists), default=0.0),
                0.95 if expected and expected in candidate_text else 0.0,
            )
    else:
        artist_score = 0.7

    duration_score = 0.72
    if candidate.duration_seconds > 0 and track.durationMs > 0:
        delta = abs(candidate.duration_seconds - (track.durationMs / 1000.0))
        duration_score = max(0.0, 1.0 - delta / 24.0)

    exact_bonus = 0.055 if expected_title and expected_title in candidate_text else 0.0
    score = (0.62 * title_score) + (0.20 * artist_score) + (0.18 * duration_score) + exact_bonus
    score -= _version_penalty(track, candidate_text)
    return max(0.0, min(1.0, score))


def _rank(track: TrackIn, available: set[AudioCandidate]) -> list[tuple[float, AudioCandidate]]:
    return sorted(
        ((score_file(track, candidate), candidate) for candidate in available),
        reverse=True,
        key=lambda row: row[0],
    )


def resolve_playlist(playlist: PlaylistIn, threshold: float = 0.62) -> tuple[list[ResolvedTrack], list[str]]:
    available = set(scan_library())
    resolved: list[ResolvedTrack] = []
    missing: list[str] = []

    for track in playlist.tracks:
        ranked = _rank(track, available)

        # Before declaring a track missing, try providers that explicitly expose a
        # downloadable file for app use. Acquired files are cached in the engine
        # media directory and then pass through the same strict matcher as local files.
        if not ranked or ranked[0][0] < threshold:
            acquired = materialize_external(track, media_root())
            if acquired:
                available.add(inspect_audio(acquired))
                ranked = _rank(track, available)

        if not ranked or ranked[0][0] < threshold:
            missing.append(f"{track.artists[0] if track.artists else 'Unknown'} — {track.name}")
            continue

        score, best = ranked[0]
        available.remove(best)
        resolved.append(
            ResolvedTrack(
                spotify_id=track.id,
                title=track.name,
                artists=track.artists,
                file_path=str(best.path),
                source_filename=best.path.name,
                match_score=score,
                image_url=track.imageUrl,
            )
        )
    return resolved, missing
