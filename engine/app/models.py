from __future__ import annotations

from enum import Enum
from pydantic import BaseModel, Field


class TrackIn(BaseModel):
    id: str
    name: str
    artists: list[str]
    album: str = ""
    durationMs: int
    imageUrl: str | None = None
    spotifyUrl: str
    explicit: bool = False


class PlaylistIn(BaseModel):
    id: str
    name: str
    description: str = ""
    imageUrl: str | None = None
    spotifyUrl: str
    tracks: list[TrackIn]


class RemixSettings(BaseModel):
    target_min_seconds: float = Field(92, ge=45, le=240)
    target_max_seconds: float = Field(142, ge=60, le=300)
    transition_seconds: float = Field(12, ge=2, le=30)
    smart_order: bool = True
    render_video: bool = True
    phrase_alignment: bool = True
    stem_transitions: bool = True
    mastering_target_lufs: float = Field(-14.0, ge=-24.0, le=-8.0)
    max_true_peak_db: float = Field(-1.0, ge=-3.0, le=-0.1)
    preview_seconds: float = Field(28.0, ge=12.0, le=60.0)


class CreateJobRequest(BaseModel):
    playlist: PlaylistIn
    settings: RemixSettings = Field(default_factory=RemixSettings)


class Section(BaseModel):
    start_seconds: float
    end_seconds: float
    label: str
    energy: float
    confidence: float = 0.5


class Analysis(BaseModel):
    bpm: float
    key: str
    key_index: int
    mode: str
    energy: float
    duration_seconds: float
    onset_strength: float
    key_confidence: float = 0.0
    tempo_stability: float = 0.0
    crest_factor_db: float = 0.0
    rms_dbfs: float = -18.0
    beat_times: list[float] = Field(default_factory=list)
    bar_times: list[float] = Field(default_factory=list)
    phrase_boundaries: list[float] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)


class ResolvedTrack(BaseModel):
    spotify_id: str
    title: str
    artists: list[str]
    file_path: str
    source_filename: str = ""
    source_provider: str = "library"
    match_score: float = 0.0
    image_url: str | None = None
    analysis: Analysis | None = None


class MixClip(BaseModel):
    spotify_id: str
    title: str
    artists: list[str]
    file_path: str
    start_seconds: float
    duration_seconds: float
    transition_seconds: float
    bpm: float
    key: str
    transition_type: str = "phrase_blend"
    compatibility_score: float = 0.0
    tempo_ratio: float = 1.0
    gain_db: float = 0.0
    use_instrumental_intro: bool = False
    section_label: str = ""
    transition_note: str = ""
    image_url: str | None = None


class MasteringReport(BaseModel):
    target_lufs: float
    target_true_peak_db: float
    input_lufs: float | None = None
    output_lufs: float | None = None
    input_true_peak_db: float | None = None
    output_true_peak_db: float | None = None
    loudness_range: float | None = None
    normalization: str = "EBU R128 two-pass"


class JobState(str, Enum):
    queued = "queued"
    resolving = "resolving"
    analyzing = "analyzing"
    planning = "planning"
    rendering = "rendering"
    mastering = "mastering"
    complete = "complete"
    blocked = "blocked"
    failed = "failed"


class JobStatus(BaseModel):
    job_id: str
    state: JobState
    message: str
    missing_tracks: list[str] = Field(default_factory=list)
    output_audio: str | None = None
    output_video: str | None = None
    clips: list[MixClip] = Field(default_factory=list)
    mastering: MasteringReport | None = None
