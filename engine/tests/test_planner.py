from app.models import Analysis, RemixSettings, ResolvedTrack
from app.planner import compatibility, plan_mix


def track(track_id: str, bpm: float, key_index: int, energy: float, duration: float = 220.0) -> ResolvedTrack:
    return ResolvedTrack(
        spotify_id=track_id,
        title=track_id,
        artists=["Artist"],
        file_path=f"/{track_id}.wav",
        analysis=Analysis(
            bpm=bpm,
            key="C major",
            key_index=key_index,
            mode="major",
            energy=energy,
            duration_seconds=duration,
            onset_strength=0.5,
        ),
    )


def test_compatibility_prefers_nearby_tracks():
    a = track("a", 120, 0, 0.5)
    close = track("close", 122, 1, 0.55)
    far = track("far", 165, 6, 0.95)
    assert compatibility(a, close) > compatibility(a, far)


def test_mix_windows_are_long_but_not_full_song():
    clips = plan_mix([track("a", 120, 0, 0.4), track("b", 122, 1, 0.5)], RemixSettings(smart_order=False))
    assert 92 <= clips[0].duration_seconds <= 142
    assert clips[0].duration_seconds < 220
    assert clips[0].transition_seconds >= 6
    assert clips[-1].transition_seconds == 0
