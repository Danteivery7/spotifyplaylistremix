from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from .models import TrackIn


@dataclass(frozen=True)
class ExternalMatch:
    provider: str
    provider_id: str
    title: str
    artist: str
    duration_seconds: float
    download_url: str
    score: float


def _norm(value: str) -> str:
    value = value.lower()
    value = re.sub(r"\([^)]*\)|\[[^]]*\]", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def _score(track: TrackIn, title: str, artist: str, duration_seconds: float) -> float:
    expected_title = _norm(track.name)
    actual_title = _norm(title)
    title_score = SequenceMatcher(None, expected_title, actual_title).ratio() if expected_title and actual_title else 0.0

    expected_artists = [_norm(value) for value in track.artists if value]
    actual_artist = _norm(artist)
    artist_score = max((SequenceMatcher(None, value, actual_artist).ratio() for value in expected_artists), default=0.0)

    duration_score = 0.65
    if duration_seconds > 0 and track.durationMs > 0:
        delta = abs(duration_seconds - track.durationMs / 1000.0)
        duration_score = max(0.0, 1.0 - delta / 18.0)

    return max(0.0, min(1.0, title_score * 0.58 + artist_score * 0.27 + duration_score * 0.15))


def _http_json(url: str, timeout: float = 12.0) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "PlaylistRemixStudio/0.4"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def find_jamendo(track: TrackIn) -> ExternalMatch | None:
    client_id = os.getenv("JAMENDO_CLIENT_ID", "").strip()
    if not client_id:
        return None

    query = " ".join([track.name, *(track.artists[:2])]).strip()
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "format": "json",
        "limit": 10,
        "search": query,
        "audioformat": "mp32",
        "audiodlformat": "mp32",
        "include": "musicinfo",
    })
    try:
        payload = _http_json(f"https://api.jamendo.com/v3.0/tracks/?{params}")
    except Exception:
        return None

    best: ExternalMatch | None = None
    for item in payload.get("results", []):
        if not item.get("audiodownload_allowed") or not item.get("audiodownload"):
            continue
        score = _score(
            track,
            str(item.get("name", "")),
            str(item.get("artist_name", "")),
            float(item.get("duration", 0.0) or 0.0),
        )
        candidate = ExternalMatch(
            provider="jamendo",
            provider_id=str(item.get("id", "")),
            title=str(item.get("name", "")),
            artist=str(item.get("artist_name", "")),
            duration_seconds=float(item.get("duration", 0.0) or 0.0),
            download_url=str(item.get("audiodownload", "")),
            score=score,
        )
        if best is None or candidate.score > best.score:
            best = candidate

    return best if best and best.score >= 0.88 else None


def materialize_external(track: TrackIn, root: Path) -> Path | None:
    """Acquire a track only from providers that explicitly expose a download URL."""
    match = find_jamendo(track)
    if not match:
        return None

    target_dir = root / "external" / match.provider
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{match.provider_id}.mp3"
    if target.is_file() and target.stat().st_size > 0:
        return target

    temp = target.with_suffix(".part")
    try:
        request = urllib.request.Request(match.download_url, headers={"User-Agent": "PlaylistRemixStudio/0.4"})
        with urllib.request.urlopen(request, timeout=30.0) as response, temp.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        if temp.stat().st_size <= 0:
            temp.unlink(missing_ok=True)
            return None
        temp.replace(target)
        return target
    except Exception:
        temp.unlink(missing_ok=True)
        return None
