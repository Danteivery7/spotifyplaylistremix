"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { PlaylistPayload } from "@/lib/types";

type RemixJob = {
  job_id: string;
  state: string;
  message: string;
  missing_tracks?: string[];
  output_audio?: string | null;
  output_video?: string | null;
};

const RUNNING_STATES = ["queued", "resolving", "analyzing", "planning", "rendering"];

function formatDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function jobLabel(state: string) {
  switch (state) {
    case "queued": return "Waiting to start";
    case "resolving": return "Finding audio";
    case "analyzing": return "Analyzing songs";
    case "planning": return "Planning transitions";
    case "rendering": return "Rendering final mix";
    case "complete": return "Ready to download";
    case "blocked": return "Audio files needed";
    case "failed": return "Mix failed";
    default: return "Preparing mix";
  }
}

export default function RemixStudio() {
  const [spotifyConnected, setSpotifyConnected] = useState<boolean | null>(null);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlist, setPlaylist] = useState<PlaylistPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<RemixJob | null>(null);

  const estimatedMinutes = useMemo(() => {
    if (!playlist) return 0;
    const perTrack = 112;
    const overlap = 12;
    return Math.max(1, Math.round((playlist.tracks.length * perTrack - Math.max(0, playlist.tracks.length - 1) * overlap) / 60));
  }, [playlist]);

  const workflow = [
    { label: "Connect Spotify", done: spotifyConnected === true, active: spotifyConnected === false },
    { label: "Load playlist", done: Boolean(playlist), active: spotifyConnected === true && !playlist },
    { label: "Create mix", done: Boolean(job), active: Boolean(playlist) && !job },
    { label: "Download", done: job?.state === "complete", active: Boolean(job) && job?.state !== "complete" }
  ];

  useEffect(() => {
    let cancelled = false;
    fetch("/api/spotify/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => {
        if (!cancelled) setSpotifyConnected(Boolean(body.connected));
      })
      .catch(() => {
        if (!cancelled) setSpotifyConnected(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!job?.job_id || !RUNNING_STATES.includes(job.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/remix/jobs?jobId=${job.job_id}`, { cache: "no-store" });
        if (response.ok) setJob(await response.json());
      } catch {
        // Keep the current state visible and retry on the next poll.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.job_id, job?.state]);

  function scrollTo(id: string) {
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
  }

  async function importPlaylist() {
    if (!spotifyConnected) {
      setError("Connect Spotify first. Then you can load the playlist link.");
      return;
    }
    if (!playlistUrl.trim()) {
      setError("Paste a Spotify playlist link first.");
      return;
    }

    setLoading(true);
    setError(null);
    setPlaylist(null);
    setJob(null);
    try {
      const response = await fetch("/api/spotify/playlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playlistUrl: playlistUrl.trim() })
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          setSpotifyConnected(false);
          throw new Error("Spotify needs to be connected again before this playlist can be loaded.");
        }
        throw new Error(body.error ?? "Could not load that playlist.");
      }
      setPlaylist(body);
      scrollTo("review-section");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while loading the playlist.");
    } finally {
      setLoading(false);
    }
  }

  async function startRemix() {
    if (!playlist || starting) return;
    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const response = await fetch("/api/remix/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playlist,
          settings: {
            target_min_seconds: 92,
            target_max_seconds: 142,
            transition_seconds: 12,
            smart_order: true,
            render_video: true
          }
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? body.error ?? "The remix engine could not start.");
      setJob(body);
      scrollTo("status-section");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the remix engine.");
    } finally {
      setStarting(false);
    }
  }

  function startOver() {
    setPlaylistUrl("");
    setPlaylist(null);
    setJob(null);
    setError(null);
    scrollTo("start-section");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#start-section" aria-label="Playlist Remix Studio home">
          <div className="brandMark">R</div>
          <span>Playlist Remix Studio</span>
        </a>
        <div className="topActions">
          {playlist && <button className="textButton" onClick={startOver}>Start Over</button>}
          <span className={`connectionPill ${spotifyConnected ? "connected" : ""}`}>
            <span className="connectionDot" />
            {spotifyConnected === null ? "Checking Spotify…" : spotifyConnected ? "Spotify connected" : "Spotify not connected"}
          </span>
        </div>
      </header>

      <section className="hero" id="start-section">
        <div className="eyebrow">Automatic long-form playlist mixing</div>
        <h1>One playlist link. One finished mix.</h1>
        <p className="sub">Connect Spotify, paste your playlist, and press one button. The app handles the track analysis, long song sections, transitions, audio render, and 16:9 video render for you.</p>
      </section>

      <nav className="progressNav" aria-label="Remix progress">
        {workflow.map((step, index) => (
          <div className={`progressStep ${step.done ? "done" : ""} ${step.active ? "active" : ""}`} key={step.label}>
            <span className="progressNumber">{step.done ? "✓" : index + 1}</span>
            <span>{step.label}</span>
          </div>
        ))}
      </nav>

      <section className="card actionCard">
        <div className="actionStep">
          <div className="actionNumber">1</div>
          <div className="actionCopy">
            <h2>Connect Spotify</h2>
            <p>This lets the app read the playlist you choose. You only need to do this again if the connection expires.</p>
          </div>
          {spotifyConnected ? (
            <div className="successBadge">✓ Connected</div>
          ) : (
            <a className="primary actionButton" href="/api/spotify/login">Connect Spotify</a>
          )}
        </div>

        <div className="actionDivider" />

        <div className="actionStep">
          <div className="actionNumber">2</div>
          <div className="actionCopy">
            <h2>Paste your playlist</h2>
            <p>Use a Spotify playlist link. The app will load the songs so you can confirm everything before rendering.</p>
            <div className="inputRow">
              <input
                className="urlInput"
                value={playlistUrl}
                onChange={(event) => setPlaylistUrl(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && importPlaylist()}
                placeholder="https://open.spotify.com/playlist/..."
                aria-label="Spotify playlist URL"
                disabled={!spotifyConnected || loading}
              />
              {spotifyConnected ? (
                <button className="primary" onClick={importPlaylist} disabled={loading || !playlistUrl.trim()}>
                  {loading ? "Loading Playlist…" : "Load Playlist"}
                </button>
              ) : (
                <a className="secondary buttonLink" href="/api/spotify/login">Connect Spotify First</a>
              )}
            </div>
          </div>
        </div>

        {error && <div className="error" role="alert">{error}</div>}
      </section>

      {playlist && (
        <section className="card playlist" id="review-section">
          <div className="sectionKicker"><span>3</span> Review and create</div>
          <div className="playlistHead">
            {playlist.imageUrl ? <Image className="art" src={playlist.imageUrl} alt="" width={88} height={88} /> : <div className="art" />}
            <div className="playlistMeta">
              <h2>{playlist.name}</h2>
              <p>{playlist.tracks.length} songs · estimated finished mix around {estimatedMinutes} minutes</p>
            </div>
          </div>

          <div className="mixSummary">
            <div><span>Song sections</span><strong>1:32–2:22 each</strong></div>
            <div><span>Transitions</span><strong>About 12 seconds</strong></div>
            <div><span>Ordering</span><strong>Smart musical order</strong></div>
            <div><span>Output</span><strong>Audio + 16:9 video</strong></div>
          </div>

          <div className="createBar">
            <div>
              <strong>Ready to build this mix?</strong>
              <span>You do not need to adjust anything unless you want to change playlists.</span>
            </div>
            <div className="createActions">
              <button className="secondary" onClick={startOver}>Choose Different Playlist</button>
              <button className="primary createButton" onClick={startRemix} disabled={starting || RUNNING_STATES.includes(job?.state ?? "")}>
                {starting ? "Starting Mix…" : RUNNING_STATES.includes(job?.state ?? "") ? "Mix Is Running" : "Create My Mix"}
              </button>
            </div>
          </div>

          <details className="trackDetails">
            <summary>See all {playlist.tracks.length} songs</summary>
            <div className="trackList">
              {playlist.tracks.map((track, index) => (
                <div className="track" key={`${track.id}-${index}`}>
                  <div className="trackIndex">{index + 1}</div>
                  {track.imageUrl ? <Image className="trackArt" src={track.imageUrl} alt="" width={48} height={48} /> : <div className="trackArt" />}
                  <div className="trackText">
                    <div className="trackTitle">{track.name}</div>
                    <div className="trackArtist">{track.artists.join(", ")} · {track.album}</div>
                  </div>
                  <div className="duration">{formatDuration(track.durationMs)}</div>
                </div>
              ))}
            </div>
          </details>
        </section>
      )}

      {job && (
        <section className="card jobCard" id="status-section" aria-live="polite">
          <div className="sectionKicker"><span>4</span> Mix status</div>
          <div className="jobHeader">
            <div>
              <h2>{jobLabel(job.state)}</h2>
              <p>{job.message}</p>
            </div>
            <div className={`statusDot ${job.state}`} aria-label={job.state} />
          </div>

          {RUNNING_STATES.includes(job.state) && (
            <div className="renderSteps">
              {["Finding audio", "Analyzing songs", "Planning transitions", "Rendering final mix"].map((label, index) => {
                const order: Record<string, number> = { queued: 0, resolving: 0, analyzing: 1, planning: 2, rendering: 3 };
                const current = order[job.state] ?? 0;
                return <div className={`renderStep ${index < current ? "done" : ""} ${index === current ? "active" : ""}`} key={label}><span>{index < current ? "✓" : index + 1}</span>{label}</div>;
              })}
            </div>
          )}

          {job.missing_tracks && job.missing_tracks.length > 0 && (
            <div className="missing">
              <strong>These songs still need authorized audio files:</strong>
              <div>{job.missing_tracks.slice(0, 12).join(" • ")}{job.missing_tracks.length > 12 ? ` • +${job.missing_tracks.length - 12} more` : ""}</div>
              <button className="primary retryButton" onClick={startRemix}>Retry After Adding Files</button>
            </div>
          )}

          {job.state === "failed" && (
            <div className="jobActions">
              <button className="secondary" onClick={startOver}>Start Over</button>
              <button className="primary" onClick={startRemix}>Retry Mix</button>
            </div>
          )}

          {job.state === "complete" && (
            <div className="downloadArea">
              <div>
                <strong>Your mix is finished.</strong>
                <span>Download either version below. The video contains the same finished mix in 16:9 format.</span>
              </div>
              <div className="downloadButtons">
                {job.output_audio && <a className="secondary buttonLink" href={`/api/remix/download?jobId=${job.job_id}&kind=audio`}>Download Audio</a>}
                {job.output_video && <a className="primary buttonLink" href={`/api/remix/download?jobId=${job.job_id}&kind=video`}>Download Video</a>}
              </div>
            </div>
          )}
        </section>
      )}

      <p className="legal">Spotify is used for playlist metadata and attribution. The remix engine only processes audio from files or catalogs you are authorized to use.</p>
    </main>
  );
}
