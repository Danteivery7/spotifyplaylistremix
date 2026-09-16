from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .analyzer import analyze_tracks
from .library import resolve_playlist
from .models import CreateJobRequest, JobState, JobStatus
from .planner import plan_mix
from .renderer import render_audio, render_video

app = FastAPI(title="Playlist Remix Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

JOBS: dict[str, JobStatus] = {}


def update(job_id: str, **changes) -> None:
    JOBS[job_id] = JOBS[job_id].model_copy(update=changes)


def process_job(job_id: str, request: CreateJobRequest) -> None:
    try:
        update(job_id, state=JobState.resolving, message="Resolving authorized audio files…")
        resolved, missing = resolve_playlist(request.playlist)
        if missing:
            update(job_id, state=JobState.blocked, message="Some playlist tracks are not present in the authorized media library.", missing_tracks=missing)
            return

        update(job_id, state=JobState.analyzing, message=f"Analyzing {len(resolved)} tracks for tempo, key and energy…")
        analyzed = analyze_tracks(resolved)

        update(job_id, state=JobState.planning, message="Building the transition order and song windows…")
        clips = plan_mix(analyzed, request.settings)
        update(job_id, clips=clips)

        root = Path(os.getenv("OUTPUT_PATH", "./output")).resolve()
        root.mkdir(parents=True, exist_ok=True)
        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in request.playlist.name)[:70]
        audio_path = root / f"{safe_name}-{job_id[:8]}.m4a"

        update(job_id, state=JobState.rendering, message="Rendering the long-form mix…")
        rendered_audio = render_audio(clips, str(audio_path))
        video_path = None
        if request.settings.render_video:
            video_path = render_video(rendered_audio, str(audio_path.with_suffix(".mp4")), request.playlist.name)

        update(job_id, state=JobState.complete, message="Mix complete.", output_audio=rendered_audio, output_video=video_path)
    except Exception as exc:
        update(job_id, state=JobState.failed, message=f"Render failed: {exc}")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/jobs", response_model=JobStatus, status_code=202)
def create_job(request: CreateJobRequest) -> JobStatus:
    if not request.playlist.tracks:
        raise HTTPException(status_code=400, detail="Playlist contains no tracks.")
    job_id = uuid.uuid4().hex
    status = JobStatus(job_id=job_id, state=JobState.queued, message="Queued for remix.")
    JOBS[job_id] = status
    threading.Thread(target=process_job, args=(job_id, request), daemon=True).start()
    return status


@app.get("/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JOBS[job_id]
