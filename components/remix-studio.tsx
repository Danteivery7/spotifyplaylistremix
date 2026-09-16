"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { PlaylistPayload } from "@/lib/types";

function formatDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function RemixStudio() {
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlist, setPlaylist] = useState<PlaylistPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<any | null>(null);

  const estimatedMinutes = useMemo(() => {
    if (!playlist) return 0;
    const perTrack = 112;
    const overlap = 12;
    return Math.round((playlist.tracks.length * perTrack - Math.max(0, playlist.tracks.length - 1) * overlap) / 60);
  }, [playlist]);

  useEffect(() => {
    if (!job?.job_id || ["complete", "blocked", "failed"].includes(job.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/remix/jobs?jobId=${job.job_id}`, { cache: "no-store" });
        if (response.ok) setJob(await response.json());
      } catch {
        // Keep the existing status visible; the next poll can recover.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.job_id, job?.state]);

  async function importPlaylist() {
    setLoading(true);
    setError(null);
    setPlaylist(null);
    try {
      const response = await fetch("/api/spotify/playlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playlistUrl })
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          setError("Connect Spotify first, then paste a playlist you own or collaborate on.");
          return;
        }
        throw new Error(body.error ?? "Could not load that playlist.");
      }
      setPlaylist(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function startRemix() {
    if (!playlist) return;
    setError(null);
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
      if (!response.ok) throw new Error(body.detail ?? body.error ?? "The audio engine could not start the remix.");
      setJob(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the audio engine.");
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><div className="brandMark">R</div>Playlist Remix Studio</div>
        <a className="pill" href="/api/spotify/login">Connect Spotify</a>
      </header>

      <section className="hero">
        <div className="eyebrow">Rave-style long-form mixes, rebuilt properly</div>
        <h1>Paste the playlist. Get the mix.</h1>
        <p className="sub">The engine keeps enough of every song to actually enjoy it, then builds long, musical transitions into a 60–90+ minute finished mix instead of chopping songs into tiny clips.</p>
      </section>

      <section className="card inputCard">
        <div className="inputRow">
          <input className="urlInput" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && importPlaylist()} placeholder="https://open.spotify.com/playlist/..." aria-label="Spotify playlist URL" />
          <button className="primary" onClick={importPlaylist} disabled={loading || !playlistUrl.trim()}>{loading ? "Reading playlist…" : "Create remix"}</button>
        </div>
        <p className="hint">Spotify is used for playlist metadata and attribution only. Audio is resolved from files or catalogs you are authorized to process.</p>
        {error && <div className="error">{error}</div>}
      </section>

      <section className="workflow" aria-label="Workflow">
        <div className="step"><strong>1. Read playlist</strong><span>Track names, artists, order and artwork.</span></div>
        <div className="step"><strong>2. Analyze music</strong><span>Beat, key, energy, sections and transition fit.</span></div>
        <div className="step"><strong>3. Render one mix</strong><span>Long-form audio plus optional 16:9 video.</span></div>
      </section>

      {playlist && (
        <section className="card playlist">
          <div className="playlistHead">
            {playlist.imageUrl ? <Image className="art" src={playlist.imageUrl} alt="" width={88} height={88} /> : <div className="art" />}
            <div className="playlistMeta"><h2>{playlist.name}</h2><p>{playlist.tracks.length} songs · estimated mix around {estimatedMinutes} minutes</p></div>
            <button className="primary" onClick={startRemix}>Start engine</button>
          </div>
          <div className="controls">
            <div className="settingGroup"><div className="setting">Song window <b>1:32–2:22</b></div><div className="setting">Transitions <b>~12 sec</b></div><div className="setting">Ordering <b>Smart</b></div></div>
            <div className="setting">Output <b>Audio + 16:9 video</b></div>
          </div>
          <div className="trackList">
            {playlist.tracks.map((track, index) => (
              <a className="track" key={`${track.id}-${index}`} href={track.spotifyUrl} target="_blank" rel="noreferrer">
                <div className="trackIndex">{index + 1}</div>
                {track.imageUrl ? <Image className="trackArt" src={track.imageUrl} alt="" width={48} height={48} /> : <div className="trackArt" />}
                <div><div className="trackTitle">{track.name}</div><div className="trackArtist">{track.artists.join(", ")} · {track.album}</div></div>
                <div className="duration">{formatDuration(track.durationMs)}</div>
              </a>
            ))}
          </div>
        </section>
      )}

      {job && (
        <section className="card jobCard">
          <div><div className="eyebrow">Remix engine</div><h3>{job.state === "complete" ? "Mix complete" : job.state === "blocked" ? "Audio files needed" : "Building your mix"}</h3><p>{job.message}</p></div>
          <div className={`statusDot ${job.state}`} aria-label={job.state} />
          {job.missing_tracks?.length > 0 && <div className="missing"><strong>Missing from the authorized media library:</strong><div>{job.missing_tracks.slice(0, 12).join(" • ")}{job.missing_tracks.length > 12 ? ` • +${job.missing_tracks.length - 12} more` : ""}</div></div>}
          {job.state === "complete" && <div className="outputs"><span>{job.output_audio}</span>{job.output_video && <span>{job.output_video}</span>}</div>}
        </section>
      )}

      <p className="legal">Spotify metadata and artwork remain linked back to Spotify. This project intentionally does not download or stream-rip Spotify audio.</p>
    </main>
  );
}
