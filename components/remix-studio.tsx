"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { PlaylistPayload } from "@/lib/types";

type RemixClip = {
  title: string;
  artists: string[];
  transition_type: string;
  compatibility_score: number;
  transition_note: string;
  section_label: string;
  bpm: number;
  key: string;
};

type MasteringReport = {
  target_lufs: number;
  target_true_peak_db: number;
  input_lufs?: number | null;
  output_lufs?: number | null;
  input_true_peak_db?: number | null;
  output_true_peak_db?: number | null;
  loudness_range?: number | null;
  normalization: string;
};

type RemixJob = {
  job_id: string;
  state: string;
  message: string;
  missing_tracks?: string[];
  output_audio?: string | null;
  output_video?: string | null;
  clips?: RemixClip[];
  mastering?: MasteringReport | null;
};

const RUNNING_STATES = ["queued", "resolving", "analyzing", "planning", "rendering", "mastering"];

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
    case "analyzing": return "Mapping the music";
    case "planning": return "Planning the mix";
    case "rendering": return "Building transitions";
    case "mastering": return "Mastering the final mix";
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
  const [selectedTransition, setSelectedTransition] = useState(0);

  const estimatedMinutes = useMemo(() => {
    if (!playlist) return 0;
    const perTrack = 112;
    const overlap = 12;
    return Math.max(1, Math.round((playlist.tracks.length * perTrack - Math.max(0, playlist.tracks.length - 1) * overlap) / 60));
  }, [playlist]);

  const clips = job?.clips ?? [];
  const previewUrl = job?.state === "complete" && clips.length > 1
    ? `/api/remix/preview?jobId=${job.job_id}&transition=${selectedTransition}`
    : null;

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
    setSelectedTransition(0);
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
    setSelectedTransition(0);
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
            render_video: true,
            phrase_alignment: true,
            stem_transitions: true,
            mastering_target_lufs: -14,
            max_true_peak_db: -1,
            preview_seconds: 28
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
    setSelectedTransition(0);
    scrollTo("start-section");
  }

  const selectedClip = clips[selectedTransition];
  const nextClip = clips[selectedTransition + 1];

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
        <p className="sub">Connect Spotify, paste your playlist, and press one button. The engine maps beats, bars, phrases and song sections, chooses musically compatible transitions, protects vocals when stems are available, and masters the finished mix automatically.</p>
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
            <p>This lets the app read the playlist you choose. You only need to reconnect if the session expires.</p>
          </div>
          {spotifyConnected ? <div className="successBadge">✓ Connected</div> : <a className="primary actionButton" href="/api/spotify/login">Connect Spotify</a>}
        </div>
        <div className="actionDivider" />
        <div className="actionStep">
          <div className="actionNumber">2</div>
          <div className="actionCopy">
            <h2>Paste your playlist</h2>
            <p>Load the playlist so you can confirm the songs before the engine starts processing audio.</p>
            <div className="inputRow">
              <input className="urlInput" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && importPlaylist()} placeholder="https://open.spotify.com/playlist/..." aria-label="Spotify playlist URL" disabled={!spotifyConnected || loading} />
              {spotifyConnected ? <button className="primary" onClick={importPlaylist} disabled={loading || !playlistUrl.trim()}>{loading ? "Loading Playlist…" : "Load Playlist"}</button> : <a className="secondary buttonLink" href="/api/spotify/login">Connect Spotify First</a>}
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
            <div className="playlistMeta"><h2>{playlist.name}</h2><p>{playlist.tracks.length} songs · estimated finished mix around {estimatedMinutes} minutes</p></div>
          </div>
          <div className="mixSummary">
            <div><span>Song sections</span><strong>1:32–2:22 each</strong></div>
            <div><span>Transition timing</span><strong>Phrase-aligned</strong></div>
            <div><span>Mix intelligence</span><strong>Key + tempo + energy</strong></div>
            <div><span>Mastering</span><strong>-14 LUFS / -1 dBTP</strong></div>
          </div>
          <div className="createBar">
            <div><strong>Ready to build this mix?</strong><span>The advanced settings are already tuned for an automatic long-form mix.</span></div>
            <div className="createActions">
              <button className="secondary" onClick={startOver}>Choose Different Playlist</button>
              <button className="primary createButton" onClick={startRemix} disabled={starting || RUNNING_STATES.includes(job?.state ?? "")}>{starting ? "Starting Mix…" : RUNNING_STATES.includes(job?.state ?? "") ? "Mix Is Running" : "Create My Mix"}</button>
            </div>
          </div>
          <details className="trackDetails">
            <summary>See all {playlist.tracks.length} songs</summary>
            <div className="trackList">
              {playlist.tracks.map((track, index) => (
                <div className="track" key={`${track.id}-${index}`}>
                  <div className="trackIndex">{index + 1}</div>
                  {track.imageUrl ? <Image className="trackArt" src={track.imageUrl} alt="" width={48} height={48} /> : <div className="trackArt" />}
                  <div className="trackText"><div className="trackTitle">{track.name}</div><div className="trackArtist">{track.artists.join(", ")} · {track.album}</div></div>
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
          <div className="jobHeader"><div><h2>{jobLabel(job.state)}</h2><p>{job.message}</p></div><div className={`statusDot ${job.state}`} aria-label={job.state} /></div>
          {RUNNING_STATES.includes(job.state) && (
            <div className="renderSteps">
              {["Finding audio", "Mapping phrases", "Planning transitions", "Rendering transitions", "Mastering"].map((label, index) => {
                const order: Record<string, number> = { queued: 0, resolving: 0, analyzing: 1, planning: 2, rendering: 3, mastering: 4 };
                const current = order[job.state] ?? 0;
                return <div className={`renderStep ${index < current ? "done" : ""} ${index === current ? "active" : ""}`} key={label}><span>{index < current ? "✓" : index + 1}</span>{label}</div>;
              })}
            </div>
          )}
          {job.missing_tracks && job.missing_tracks.length > 0 && <div className="missing"><strong>These songs still need authorized audio files:</strong><div>{job.missing_tracks.slice(0, 12).join(" • ")}{job.missing_tracks.length > 12 ? ` • +${job.missing_tracks.length - 12} more` : ""}</div><button className="primary retryButton" onClick={startRemix}>Retry After Adding Files</button></div>}
          {job.state === "failed" && <div className="jobActions"><button className="secondary" onClick={startOver}>Start Over</button><button className="primary" onClick={startRemix}>Retry Mix</button></div>}
          {job.state === "complete" && (
            <>
              <div className="downloadArea"><div><strong>Your mix is finished.</strong><span>Download the mastered audio or the 16:9 waveform video.</span></div><div className="downloadButtons">{job.output_audio && <a className="secondary buttonLink" href={`/api/remix/download?jobId=${job.job_id}&kind=audio`}>Download Audio</a>}{job.output_video && <a className="primary buttonLink" href={`/api/remix/download?jobId=${job.job_id}&kind=video`}>Download Video</a>}</div></div>
              {clips.length > 1 && (
                <details className="trackDetails" open>
                  <summary>Hear a transition preview</summary>
                  <div style={{ padding: "4px 0 18px" }}>
                    <label style={{ display: "block", color: "#9ca296", fontSize: 13, marginBottom: 8 }} htmlFor="transition-preview">Choose any planned transition</label>
                    <select id="transition-preview" value={selectedTransition} onChange={(event) => setSelectedTransition(Number(event.target.value))} style={{ width: "100%", minHeight: 46, borderRadius: 12, border: "1px solid #30362e", background: "#0a0c0a", color: "#f4f5ef", padding: "0 12px", marginBottom: 12 }}>
                      {clips.slice(0, -1).map((clip, index) => <option value={index} key={`${clip.title}-${index}`}>{clip.title} → {clips[index + 1].title}</option>)}
                    </select>
                    {selectedClip && nextClip && <div style={{ color: "#9ca296", fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>{selectedClip.transition_note} · compatibility {Math.round(selectedClip.compatibility_score * 100)}%<br />{selectedClip.bpm.toFixed(1)} BPM / {selectedClip.key} → {nextClip.bpm.toFixed(1)} BPM / {nextClip.key}</div>}
                    {previewUrl && <audio key={previewUrl} controls preload="none" src={previewUrl} style={{ width: "100%" }} />}
                  </div>
                </details>
              )}
              {job.mastering && (
                <details className="trackDetails">
                  <summary>Mix quality details</summary>
                  <div className="mixSummary">
                    <div><span>Normalization</span><strong>{job.mastering.normalization}</strong></div>
                    <div><span>Loudness target</span><strong>{job.mastering.target_lufs.toFixed(1)} LUFS</strong></div>
                    <div><span>True-peak ceiling</span><strong>{job.mastering.target_true_peak_db.toFixed(1)} dBTP</strong></div>
                    <div><span>Measured output</span><strong>{job.mastering.output_lufs == null ? "Mastered" : `${job.mastering.output_lufs.toFixed(1)} LUFS`}</strong></div>
                  </div>
                </details>
              )}
            </>
          )}
        </section>
      )}

      <p className="legal">Spotify is used for playlist metadata and attribution. The remix engine only processes audio from files or catalogs you are authorized to use.</p>
    </main>
  );
}
