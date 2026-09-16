from pathlib import Path

from app.library import resolve_playlist
from app.models import PlaylistIn, TrackIn


def track(track_id: str, name: str, artist: str, duration_ms: int = 210000, explicit: bool = False) -> TrackIn:
    return TrackIn(
        id=track_id,
        name=name,
        artists=[artist],
        album="",
        durationMs=duration_ms,
        imageUrl=None,
        spotifyUrl=f"https://open.spotify.com/track/{track_id}",
        explicit=explicit,
    )


def test_uploaded_filename_matches_playlist_track(tmp_path: Path, monkeypatch):
    (tmp_path / "The Weeknd - Blinding Lights.mp3").write_bytes(b"")
    (tmp_path / "Dua Lipa - Levitating.mp3").write_bytes(b"")
    monkeypatch.setenv("MEDIA_LIBRARY_PATH", str(tmp_path))

    playlist = PlaylistIn(
        id="playlist",
        name="Test Mix",
        spotifyUrl="https://open.spotify.com/playlist/playlist",
        tracks=[
            track("one", "Blinding Lights", "The Weeknd"),
            track("two", "Levitating", "Dua Lipa"),
        ],
    )

    resolved, missing = resolve_playlist(playlist)

    assert missing == []
    assert [item.spotify_id for item in resolved] == ["one", "two"]
    assert resolved[0].source_filename == "The Weeknd - Blinding Lights.mp3"
    assert resolved[0].match_score >= 0.62


def test_unrelated_file_is_not_forced_into_playlist(tmp_path: Path, monkeypatch):
    (tmp_path / "Completely Different Song.mp3").write_bytes(b"")
    monkeypatch.setenv("MEDIA_LIBRARY_PATH", str(tmp_path))

    playlist = PlaylistIn(
        id="playlist",
        name="Test Mix",
        spotifyUrl="https://open.spotify.com/playlist/playlist",
        tracks=[track("one", "Blinding Lights", "The Weeknd")],
    )

    resolved, missing = resolve_playlist(playlist)

    assert resolved == []
    assert missing == ["The Weeknd — Blinding Lights"]
