from app.models import Analysis, RemixSettings, ResolvedTrack, Section
from app.planner import choose_window, compatibility, harmonic_compatibility, plan_mix


def track(
    track_id: str,
    bpm: float,
    key_index: int,
    energy: float,
    duration: float = 220.0,
    mode: str = "major",
    phrases: list[float] | None = None,
    sections: list[Section] | None = None,
    rms_dbfs: float = -18.0,
) -> ResolvedTrack:
    return ResolvedTrack(
        spotify_id=track_id,
        title=track_id,
        artists=["Artist"],
        file_path=f"/{track_id}.wav",
        analysis=Analysis(
            bpm=bpm,
            key=f"{key_index} {mode}",
            key_index=key_index,
            mode=mode,
            energy=energy,
            duration_seconds=duration,
            onset_strength=0.5,
            key_confidence=0.9,
            tempo_stability=0.95,
            rms_dbfs=rms_dbfs,
            phrase_boundaries=phrases or [],
            sections=sections or [],
        ),
    )


def test_compatibility_prefers_nearby_tracks():
    a = track("a", 120, 0, 0.5)
    close = track("close", 122, 7, 0.55)
    far = track("far", 165, 6, 0.95)
    assert compatibility(a, close) > compatibility(a, far)


def test_relative_major_minor_is_harmonically_compatible():
    c_major = track("c-major", 120, 0, 0.5, mode="major")
    a_minor = track("a-minor", 120, 9, 0.5, mode="minor")
    assert harmonic_compatibility(c_major, a_minor) > 0.9


def test_mix_windows_are_long_but_not_full_song():
    clips = plan_mix(
        [track("a", 120, 0, 0.4), track("b", 122, 7, 0.5)],
        RemixSettings(smart_order=False, stem_transitions=False),
    )
    assert 92 <= clips[0].duration_seconds <= 142
    assert clips[0].duration_seconds < 220
    assert clips[0].transition_seconds >= 5
    assert clips[-1].transition_seconds == 0


def test_phrase_window_snaps_start_and_end_to_phrase_boundaries():
    phrases = [float(x) for x in range(0, 225, 16)]
    sections = [
        Section(start_seconds=0, end_seconds=48, label="verse", energy=0.45),
        Section(start_seconds=48, end_seconds=96, label="chorus_drop", energy=0.95),
        Section(start_seconds=96, end_seconds=160, label="verse", energy=0.62),
        Section(start_seconds=160, end_seconds=224, label="chorus_drop", energy=0.9),
    ]
    item = track("phrased", 120, 0, 0.6, duration=224, phrases=phrases, sections=sections)
    start, length, _ = choose_window(item, RemixSettings())
    end = round(start + length, 3)
    assert start in phrases
    assert end in phrases
    assert 92 <= length <= 142


def test_high_quality_transition_marks_incoming_clip_for_instrumental_intro():
    clips = plan_mix(
        [track("a", 120, 0, 0.5), track("b", 121, 7, 0.52)],
        RemixSettings(smart_order=False, stem_transitions=True),
    )
    assert clips[0].transition_type == "stem_blend"
    assert clips[1].use_instrumental_intro is True


def test_clip_gain_normalization_is_bounded():
    clips = plan_mix(
        [
            track("quiet", 120, 0, 0.4, rms_dbfs=-26),
            track("loud", 122, 7, 0.5, rms_dbfs=-10),
        ],
        RemixSettings(smart_order=False, stem_transitions=False),
    )
    assert -5.0 <= clips[0].gain_db <= 5.0
    assert -5.0 <= clips[1].gain_db <= 5.0
