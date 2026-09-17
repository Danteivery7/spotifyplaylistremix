from __future__ import annotations

from app.external_sources import find_jamendo
from app.models import TrackIn


def test_jamendo_prefers_exact_downloadable_match(monkeypatch):
    monkeypatch.setenv("JAMENDO_CLIENT_ID", "test-client")

    def fake_http_json(url: str, timeout: float = 12.0):
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

    track = TrackIn(
        id="spotify-track",
        name="Blinding Lights",
        artists=["The Weeknd"],
        album="After Hours",
        durationMs=200000,
        imageUrl=None,
        spotifyUrl="https://open.spotify.com/track/example",
        explicit=False,
    )

    match = find_jamendo(track)
    assert match is not None
    assert match.provider_id == "2"
    assert match.download_url.endswith("right.mp3")
    assert match.score >= 0.88


def test_jamendo_ignores_provider_when_not_configured(monkeypatch):
    monkeypatch.delenv("JAMENDO_CLIENT_ID", raising=False)
    track = TrackIn(
        id="spotify-track",
        name="Song",
        artists=["Artist"],
        album="Album",
        durationMs=180000,
        imageUrl=None,
        spotifyUrl="https://open.spotify.com/track/example",
        explicit=False,
    )
    assert find_jamendo(track) is None
