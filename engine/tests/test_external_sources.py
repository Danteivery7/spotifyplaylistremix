from __future__ import annotations

from app.external_sources import find_audius, find_jamendo, find_soundcloud
from app.models import TrackIn


def sample_track() -> TrackIn:
    return TrackIn(
        id="spotify-track",
        name="Blinding Lights",
        artists=["The Weeknd"],
        album="After Hours",
        durationMs=200000,
        imageUrl=None,
        spotifyUrl="https://open.spotify.com/track/example",
        explicit=False,
    )


def test_jamendo_prefers_exact_downloadable_match(monkeypatch):
    monkeypatch.setenv("JAMENDO_CLIENT_ID", "test-client")

    def fake_http_json(url: str, timeout: float = 12.0, headers=None):
        return {
            "results": [
                {
                    "id": "1",
                    "name": "Blinding Lights (Acoustic Cover)",
                    "artist_name": "Someone Else",
                    "duration": 181,
                    "audiodownload_allowed": True,
                    "audiodownload": "https://example.com/wrong.mp3",
                },
                {
                    "id": "2",
                    "name": "Blinding Lights",
                    "artist_name": "The Weeknd",
                    "duration": 200,
                    "audiodownload_allowed": True,
                    "audiodownload": "https://example.com/right.mp3",
                },
            ]
        }

    monkeypatch.setattr("app.external_sources._http_json", fake_http_json)
    match = find_jamendo(sample_track())
    assert match is not None
    assert match.provider_id == "2"
    assert match.download_url.endswith("right.mp3")
    assert match.score >= 0.88


def test_jamendo_ignores_provider_when_not_configured(monkeypatch):
    monkeypatch.delenv("JAMENDO_CLIENT_ID", raising=False)
    assert find_jamendo(sample_track()) is None


def test_soundcloud_uses_only_downloadable_exact_tracks(monkeypatch):
    monkeypatch.setattr("app.external_sources._soundcloud_token", lambda: "token")

    def fake_http_json(url: str, timeout: float = 12.0, headers=None):
        return {
            "collection": [
                {
                    "urn": "soundcloud:tracks:wrong",
                    "title": "Blinding Lights (Live Cover)",
                    "metadata_artist": "Someone Else",
                    "duration": 200000,
                    "downloadable": True,
                    "download_url": "https://api.soundcloud.com/tracks/wrong/download",
                    "user": {"username": "Someone Else"},
                },
                {
                    "urn": "soundcloud:tracks:stream-only",
                    "title": "Blinding Lights",
                    "metadata_artist": "The Weeknd",
                    "duration": 200000,
                    "downloadable": False,
                    "download_url": "https://api.soundcloud.com/tracks/stream-only/download",
                    "user": {"username": "The Weeknd"},
                },
                {
                    "urn": "soundcloud:tracks:right",
                    "title": "Blinding Lights",
                    "metadata_artist": "The Weeknd",
                    "duration": 200000,
                    "downloadable": True,
                    "download_url": "https://api.soundcloud.com/tracks/right/download",
                    "user": {"username": "The Weeknd"},
                },
            ]
        }

    monkeypatch.setattr("app.external_sources._http_json", fake_http_json)
    match = find_soundcloud(sample_track())
    assert match is not None
    assert match.provider == "soundcloud"
    assert match.provider_id == "right"
    assert match.auth_header == "OAuth token"
    assert match.score >= 0.90


def test_audius_uses_only_ungated_downloadable_tracks(monkeypatch):
    monkeypatch.setenv("AUDIUS_API_KEY", "api-key")
    monkeypatch.setenv("AUDIUS_BEARER_TOKEN", "bearer")

    def fake_http_json(url: str, timeout: float = 12.0, headers=None):
        return {
            "data": [
                {
                    "id": "gated",
                    "title": "Blinding Lights",
                    "duration": 200,
                    "is_downloadable": True,
                    "download_conditions": {"follow_user_id": "123"},
                    "user": {"name": "The Weeknd"},
                },
                {
                    "id": "right",
                    "title": "Blinding Lights",
                    "duration": 200,
                    "is_downloadable": True,
                    "download_conditions": None,
                    "user": {"name": "The Weeknd"},
                },
            ]
        }

    monkeypatch.setattr("app.external_sources._http_json", fake_http_json)
    match = find_audius(sample_track())
    assert match is not None
    assert match.provider == "audius"
    assert match.provider_id == "right"
    assert "/tracks/right/download" in match.download_url
    assert match.auth_header == "Bearer bearer"
    assert match.score >= 0.90
