from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path
from difflib import SequenceMatcher

from .models import PlaylistIn, ResolvedTrack

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"}


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"\([^)]*\)|\[[^]]*\]", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def score_file(track_name: str, artists: list[str], path: Path) -> float:
    stem = normalize(path.stem)
    title = normalize(track_name)
    artist = normalize(artists[0] if artists else "")
    title_score = SequenceMatcher(None, title, stem).ratio()
    artist_bonus = 0.12 if artist and artist in stem else 0.0
    exact_bonus = 0.18 if title and title in stem else 0.0
    return min(1.0, title_score + artist_bonus + exact_bonus)


def scan_library(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS]


def resolve_playlist(playlist: PlaylistIn, threshold: float = 0.60) -> tuple[list[ResolvedTrack], list[str]]:
    root = Path(os.getenv("MEDIA_LIBRARY_PATH", "./media")).resolve()
    files = scan_library(root)
    available = set(files)
    resolved: list[ResolvedTrack] = []
    missing: list[str] = []

    for track in playlist.tracks:
        ranked = sorted(((score_file(track.name, track.artists, path), path) for path in available), reverse=True, key=lambda row: row[0])
        if not ranked or ranked[0][0] < threshold:
            missing.append(f"{track.artists[0] if track.artists else 'Unknown'} — {track.name}")
            continue
        _, best = ranked[0]
        available.remove(best)
        resolved.append(ResolvedTrack(spotify_id=track.id, title=track.name, artists=track.artists, file_path=str(best)))
    return resolved, missing
