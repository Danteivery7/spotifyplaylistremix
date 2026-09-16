from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .analyzer import analyze_tracks
from .library import AUDIO_EXTENSIONS, media_root, resolve_playlist, scan_library
from .mastering import master_audio
from .models import CreateJobRequest, JobState, JobStatus, PlaylistIn, RemixSettings
from .planner import plan_mix
from .renderer import render_mix, render_transition_preview, render_video
from .separator import stems_enabled

app = FastAPI(title="Playlist Remix Engine", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("WEB_ORIGINS", "http://localhost:3000").split(",") if origin.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

JOBS: dict[str, JobStatus] = {}
JOB_SETTINGS: dict[str, RemixSettings] = {}


def _output_root() -> Path:
    root = Path(os.getenv("OUTPUT_PATH", "./output")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_upload_name(filename: str) -> tuple[str, str]:
    original = Path(filename).name
    extension = Path(original).suffix.lower()
    stem = Path(original).stem
    safe_stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", stem).strip(" ._")[:120] or "audio"
    return safe_stem, extension


def update(job_id: str, **changes) -> None:
    JOBS[job_id] = JOBS[job_id].model_copy(update=changes)


def process_job(job_id: str, request: CreateJobRequest) -> None:
    raw_path: Path | None = None
    try:
        update(job_id, state=JobState.resolving, message="Finding the authorized audio for every playlist track…")
        resolved, missing = resolve_playlist(request.playlist)
        if missing:
            update(
                job_id,
                state=JobState.blocked,
                message="Some selected tracks still need audio. Add files in the Audio Sources stage, or exclude those songs.",
                missing_tracks=missing,
            )
            return

        update(
            job_id,
            state=JobState.analyzing,
            message=f"Mapping beats, bars, phrases, sections, key and energy across {len(resolved)} tracks…",
        )
        analyzed = analyze_tracks(resolved)

        update(
            job_id,
            state=JobState.planning,
            message="Searching for the best full-playlist order, song windows and phrase-aligned transition points…",
        )
        clips = plan_mix(analyzed, request.settings)
        update(job_id, clips=clips)

        root = _output_root()
        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in request.playlist.name)[:70] or "playlist-remix"
        raw_path = root / f"{safe_name}-{job_id[:8]}-working.wav"
        audio_path = root / f"{safe_name}-{job_id[:8]}.m4a"

        stem_note = " with vocal-safe stem blends" if request.settings.stem_transitions and stems_enabled() else ""
        update(
            job_id,
            state=JobState.rendering,
            message=f"Rendering phrase-aligned transitions{stem_note} and subtle tempo matching…",
        )
        rendered_working = render_mix(clips, str(raw_path))

        update(
            job_id,
            state=JobState.mastering,
            message="Mastering the complete mix with two-pass EBU R128 loudness and true-peak control…",
        )
        rendered_audio, mastering_report = master_audio(rendered_working, str(audio_path), request.settings)

        video_path = None
        if request.settings.render_video:
            update(
                job_id,
                state=JobState.mastering,
                message="Audio master is finished. Building the 16:9 waveform video…",
                mastering=mastering_report,
            )
            video_path = render_video(rendered_audio, str(audio_path.with_suffix(".mp4")), request.playlist.name)

        update(
            job_id,
            state=JobState.complete,
            message="Mix complete. Phrase alignment, transition rendering and final mastering are finished.",
            output_audio=rendered_audio,
            output_video=video_path,
            mastering=mastering_report,
        )
    except Exception as exc:
        update(job_id, state=JobState.failed, message=f"Render failed: {exc}")
    finally:
        if raw_path and raw_path.exists():
            raw_path.unlink(missing_ok=True)


@app.get("/health")
def health() -> dict[str, str | bool | int]:
    return {
        "status": "ok",
        "version": "0.3.0",
        "stems_enabled": stems_enabled(),
        "audio_files": len(scan_library()),
    }


@app.get("/media/status")
def media_status() -> dict[str, int | str]:
    root = media_root()
    return {
        "files": len(scan_library(root)),
        "max_upload_mb": int(os.getenv("MAX_AUDIO_UPLOAD_MB", "96")),
        "library": str(root),
    }


@app.post("/media/upload")
async def upload_media(file: UploadFile = File(...)) -> dict[str, int | str]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="An audio filename is required.")

    safe_stem, extension = _safe_upload_name(file.filename)
    if extension not in AUDIO_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Use MP3, WAV, FLAC, M4A, AAC, OGG, or OPUS audio files.")

    upload_root = media_root() / "uploads"
    upload_root.mkdir(parents=True, exist_ok=True)
    target = upload_root / f"{safe_stem}{extension}"
    if target.exists():
        target = upload_root / f"{safe_stem}-{uuid.uuid4().hex[:8]}{extension}"
    temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")

    max_bytes = int(os.getenv("MAX_AUDIO_UPLOAD_MB", "96")) * 1024 * 1024
    size = 0
    try:
        with temp.open("wb") as handle:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(status_code=413, detail=f"Audio files must be under {max_bytes // (1024 * 1024)} MB each.")
                handle.write(chunk)
        temp.replace(target)
    except Exception:
        temp.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    return {
        "filename": target.name,
        "bytes": size,
        "library_files": len(scan_library()),
    }


@app.post("/media/resolve")
def resolve_media(playlist: PlaylistIn) -> dict:
    if not playlist.tracks:
        raise HTTPException(status_code=400, detail="Playlist contains no tracks.")
    resolved, missing = resolve_playlist(playlist)
    return {
        "ready": not missing and len(resolved) == len(playlist.tracks),
        "total": len(playlist.tracks),
        "matched": len(resolved),
        "missing": missing,
        "matches": [
            {
                "spotify_id": track.spotify_id,
                "title": track.title,
                "artists": track.artists,
                "filename": track.source_filename or Path(track.file_path).name,
                "score": track.match_score,
            }
            for track in resolved
        ],
    }


@app.post("/jobs", response_model=JobStatus, status_code=202)
def create_job(request: CreateJobRequest) -> JobStatus:
    if not request.playlist.tracks:
        raise HTTPException(status_code=400, detail="Playlist contains no tracks.")
    job_id = uuid.uuid4().hex
    status = JobStatus(job_id=job_id, state=JobState.queued, message="Queued for remix.")
    JOBS[job_id] = status
    JOB_SETTINGS[job_id] = request.settings
    threading.Thread(target=process_job, args=(job_id, request), daemon=True).start()
    return status


@app.get("/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JOBS[job_id]


@app.get("/jobs/{job_id}/preview/{transition_index}")
def preview_transition(job_id: str, transition_index: int):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    job = JOBS[job_id]
    if job.state != JobState.complete:
        raise HTTPException(status_code=409, detail="Wait for the full mix to finish before generating previews.")
    if transition_index < 0 or transition_index >= len(job.clips) - 1:
        raise HTTPException(status_code=400, detail="Transition index is out of range.")

    preview_root = _output_root() / "previews"
    preview_root.mkdir(parents=True, exist_ok=True)
    preview_path = preview_root / f"{job_id}-{transition_index}.m4a"
    if not preview_path.exists():
        settings = JOB_SETTINGS.get(job_id, RemixSettings())
        render_transition_preview(job.clips, transition_index, str(preview_path), settings)

    return FileResponse(path=preview_path, media_type="audio/mp4", filename=preview_path.name)


@app.get("/jobs/{job_id}/download/{kind}")
def download_job_output(job_id: str, kind: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    if kind not in {"audio", "video"}:
        raise HTTPException(status_code=400, detail="kind must be audio or video.")

    job = JOBS[job_id]
    if job.state != JobState.complete:
        raise HTTPException(status_code=409, detail="The mix is not ready to download yet.")

    output = job.output_audio if kind == "audio" else job.output_video
    if not output:
        raise HTTPException(status_code=404, detail=f"No {kind} output is available for this job.")

    output_root = _output_root()
    path = Path(output).resolve()
    if path != output_root and output_root not in path.parents:
        raise HTTPException(status_code=403, detail="Output path is outside the configured output directory.")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Rendered file was not found on disk.")

    media_type = "audio/mp4" if kind == "audio" else "video/mp4"
    return FileResponse(path=path, media_type=media_type, filename=path.name)
