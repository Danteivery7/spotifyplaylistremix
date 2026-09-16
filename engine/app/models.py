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


class CreateJobRequest(BaseModel):
    playlist: PlaylistIn
    settings: RemixSettings = RemixSettings()


class Analysis(BaseModel):
    bpm: float
    key: str
    key_index: int
    mode: str
    energy: float
    duration_seconds: float
    onset_strength: float


class ResolvedTrack(BaseModel):
    spotify_id: str
    title: str
    artists: list[str]
    file_path: str
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
    transition_type: str = "blend"


class JobState(str, Enum):
    queued = "queued"
    resolving = "resolving"
    analyzing = "analyzing"
    planning = "planning"
    rendering = "rendering"
    complete = "complete"
    blocked = "blocked"
    failed = "failed"


class JobStatus(BaseModel):
    job_id: str
    state: JobState
    message: str
    missing_tracks: list[str] = []
    output_audio: str | None = None
    output_video: str | None = None
    clips: list[MixClip] = []
