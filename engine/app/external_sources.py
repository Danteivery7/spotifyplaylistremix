from __future__ import annotations

import base64
import json
import os
import re
import time
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
    auth_header: str = ""
    extension: str = ".mp3"


_SOUNDCLOUD_TOKEN: dict[str, object] = {}
_PROVIDER_PRIORITY = {"soundcloud": 3, "audius": 2, "jamendo": 1}
_VERSION_WORDS = {"live", "remix", "mix", "clean", "radio", "edit", "acoustic", "instrumental", "karaoke", "sped", "slowed", "cover"}


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

    score = title_score * 0.58 + artist_score * 0.27 + duration_score * 0.15

    target_text = _norm(f"{track.name} {track.album}")
    candidate_text = _norm(f"{title} {artist}")
    for word in _VERSION_WORDS:
        if word in candidate_text and word not in target_text:
            score -= 0.055
    if track.explicit and ("clean" in candidate_text or "radio edit" in candidate_text or "censored" in candidate_text):
        score -= 0.18

    return max(0.0, min(1.0, score))


def _http_json(url: str, timeout: float = 12.0, headers: dict[str, str] | None = None) -> dict:
    request_headers = {"User-Agent": "PlaylistRemixStudio/0.5", "Accept": "application/json"}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _post_form_json(url: str, form: dict[str, str], headers: dict[str, str] | None = None, timeout: float = 12.0) -> dict:
    body = urllib.parse.urlencode(form).encode("utf-8")
    request_headers = {
        "User-Agent": "PlaylistRemixStudio/0.5",
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    request_headers.update(headers or {})
    request = urllib.request.Request(url, data=body, headers=request_headers, method="POST")
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


def _soundcloud_token() -> str | None:
    manual = os.getenv("SOUNDCLOUD_ACCESS_TOKEN", "").strip()
    if manual:
        return manual

    client_id = os.getenv("SOUNDCLOUD_CLIENT_ID", "").strip()
    client_secret = os.getenv("SOUNDCLOUD_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return None

    now = time.time()
    cached = str(_SOUNDCLOUD_TOKEN.get("access_token", "") or "")
    expires_at = float(_SOUNDCLOUD_TOKEN.get("expires_at", 0.0) or 0.0)
    if cached and expires_at > now + 60:
        return cached

    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    refresh_token = str(_SOUNDCLOUD_TOKEN.get("refresh_token", "") or "")
    try:
        if refresh_token:
            payload = _post_form_json(
                "https://secure.soundcloud.com/oauth/token",
                {
                    "grant_type": "refresh_token",
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh_token,
                },
            )
        else:
            payload = _post_form_json(
                "https://secure.soundcloud.com/oauth/token",
                {"grant_type": "client_credentials"},
                headers={"Authorization": f"Basic {basic}"},
            )
    except Exception:
        return None

    token = str(payload.get("access_token", "") or "")
    if not token:
        return None
    _SOUNDCLOUD_TOKEN["access_token"] = token
    _SOUNDCLOUD_TOKEN["refresh_token"] = str(payload.get("refresh_token", "") or "")
    _SOUNDCLOUD_TOKEN["expires_at"] = now + max(120.0, float(payload.get("expires_in", 3600) or 3600))
    return token


def find_soundcloud(track: TrackIn) -> ExternalMatch | None:
    token = _soundcloud_token()
    if not token:
        return None

    query = " ".join([track.name, *(track.artists[:2])]).strip()
    params = urllib.parse.urlencode({
        "q": query,
        "limit": 20,
        "linked_partitioning": "true",
        "access": "playable",
    })
    headers = {"Authorization": f"OAuth {token}"}
    try:
        payload = _http_json(f"https://api.soundcloud.com/tracks?{params}", headers=headers)
    except Exception:
        return None

    items = payload.get("collection", [])
    if not isinstance(items, list):
        return None

    best: ExternalMatch | None = None
    for item in items:
        if not isinstance(item, dict) or not item.get("downloadable") or not item.get("download_url"):
            continue
        user = item.get("user") if isinstance(item.get("user"), dict) else {}
        artist = str(item.get("metadata_artist") or user.get("username") or "")
        duration_seconds = float(item.get("duration", 0.0) or 0.0) / 1000.0
        score = _score(track, str(item.get("title", "")), artist, duration_seconds)
        provider_id = str(item.get("urn") or item.get("id") or "")
        candidate = ExternalMatch(
            provider="soundcloud",
            provider_id=provider_id.replace("soundcloud:tracks:", ""),
            title=str(item.get("title", "")),
            artist=artist,
            duration_seconds=duration_seconds,
            download_url=str(item.get("download_url", "")),
            score=score,
            auth_header=f"OAuth {token}",
        )
        if best is None or candidate.score > best.score:
            best = candidate

    return best if best and best.score >= 0.90 else None


def find_audius(track: TrackIn) -> ExternalMatch | None:
    api_key = os.getenv("AUDIUS_API_KEY", "").strip()
    bearer = os.getenv("AUDIUS_BEARER_TOKEN", "").strip()
    app_name = os.getenv("AUDIUS_APP_NAME", "PlaylistRemixStudio").strip() or "PlaylistRemixStudio"
    if not api_key and not bearer:
        return None

    query = " ".join([track.name, *(track.artists[:2])]).strip()
    params = {
        "query": query,
        "limit": "20",
        "only_downloadable": "true",
        "app_name": app_name,
    }
    if api_key:
        params["api_key"] = api_key
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
    try:
        payload = _http_json(
            f"https://api.audius.co/v1/tracks/search?{urllib.parse.urlencode(params)}",
            headers=headers,
        )
    except Exception:
        return None

    items = payload.get("data", [])
    if not isinstance(items, list):
        return None

    best: ExternalMatch | None = None
    for item in items:
        if not isinstance(item, dict):
            continue
        access = item.get("access") if isinstance(item.get("access"), dict) else {}
        downloadable = bool(item.get("is_downloadable") or item.get("isDownloadable") or item.get("downloadable") or access.get("download"))
        gated = item.get("download_conditions") or item.get("downloadConditions")
        if not downloadable or gated:
            continue
        user = item.get("user") if isinstance(item.get("user"), dict) else {}
        artist = str(user.get("name") or user.get("handle") or "")
        duration_seconds = float(item.get("duration", 0.0) or 0.0)
        score = _score(track, str(item.get("title", "")), artist, duration_seconds)
        provider_id = str(item.get("id", "") or "")
        if not provider_id:
            continue
        download_params = {"app_name": app_name}
        if api_key:
            download_params["api_key"] = api_key
        candidate = ExternalMatch(
            provider="audius",
            provider_id=provider_id,
            title=str(item.get("title", "")),
            artist=artist,
            duration_seconds=duration_seconds,
            download_url=f"https://api.audius.co/v1/tracks/{urllib.parse.quote(provider_id)}/download?{urllib.parse.urlencode(download_params)}",
            score=score,
            auth_header=f"Bearer {bearer}" if bearer else "",
        )
        if best is None or candidate.score > best.score:
            best = candidate

    return best if best and best.score >= 0.90 else None


def find_external(track: TrackIn) -> ExternalMatch | None:
    candidates = [candidate for candidate in (find_soundcloud(track), find_audius(track), find_jamendo(track)) if candidate]
    if not candidates:
        return None
    return max(candidates, key=lambda candidate: (candidate.score, _PROVIDER_PRIORITY.get(candidate.provider, 0)))


def materialize_external(track: TrackIn, root: Path) -> Path | None:
    """Acquire only from providers that explicitly expose a downloadable track file."""
    match = find_external(track)
    if not match:
        return None

    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", match.provider_id).strip("._") or "track"
    target_dir = root / "external" / match.provider
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{safe_id}{match.extension}"
    if target.is_file() and target.stat().st_size > 0:
        return target

    temp = target.with_suffix(f"{target.suffix}.part")
    headers = {"User-Agent": "PlaylistRemixStudio/0.5"}
    if match.auth_header:
        headers["Authorization"] = match.auth_header
    try:
        request = urllib.request.Request(match.download_url, headers=headers)
        with urllib.request.urlopen(request, timeout=60.0) as response, temp.open("wb") as handle:
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
