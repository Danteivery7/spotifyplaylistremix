"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import AudioSourceStageV2 from "@/components/audio-source-stage-v2";
import type { PlaylistPayload } from "@/lib/types";
import {
  beginSpotifyLogin,
  completeSpotifyLoginFromUrl,
  disconnectSpotify,
  ensureSpotifyAccessToken,
  getSpotifyClientId,
  rememberPendingPlaylist,
  saveSpotifyClientId,
  spotifyRedirectUri,
  takePendingPlaylist,
} from "@/lib/spotify-pkce";
import { personalEngineDownload, personalEngineEndpoint } from "@/lib/personal-engine";

type AccountPlaylist = {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  spotifyUrl: string;
  ownerName: string;
  totalTracks: number;
};

type RemixJob = {
  job_id: string;
  state: string;
  message: string;
  missing_tracks?: string[];
  output_audio?: string | null;
  output_video?: string | null;
};

type ApiBody = Record<string, unknown> & {
  error?: string;
  detail?: string;
  code?: string;
};

const RUNNING_STATES = ["queued", "resolving", "analyzing", "planning", "rendering", "mastering"];

function formatDuration(ms: number) {
  if (!ms || ms <= 0) return "—";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function trackKey(id: string, index: number) {
  return `${id}:${index}`;
}

function jobLabel(state: string) {
  switch (state) {
    case "queued": return "Waiting to start";
    case "resolving": return "Confirming audio";
    case "analyzing": return "Mapping the music";
    case "planning": return "Planning the mix";
    case "rendering": return "Building transitions";
    case "mastering": return "Mastering the final mix";
    case "complete": return "Ready to download";
    case "blocked": return "More audio needed";
    case "failed": return "Mix failed";
    default: return "Preparing mix";
  }
}

async function readJsonResponse(response: Response): Promise<ApiBody> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as ApiBody;
  } catch {
    const clean = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (/cloudflare|worker|bad gateway|gateway timeout|error code/i.test(clean)) {
      throw new Error("The service behind this action is not reachable right now. If this happened while mixing, reconnect the personal remix engine and try again.");
    }
    throw new Error(clean ? `The site returned: ${clean}` : `The site did not return a usable response (${response.status}).`);
  }
}

export default function PersonalRemixStudioV2() {
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [spotifyClientId, setSpotifyClientId] = useState("");
  const [showSpotifySetup, setShowSpotifySetup] = useState(false);
  const [redirectUri, setRedirectUri] = useState("");
  const [authBusy, setAuthBusy] = useState(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [accountPlaylists, setAccountPlaylists] = useState<AccountPlaylist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistsOpen, setPlaylistsOpen] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlist, setPlaylist] = useState<PlaylistPayload | null>(null);
  const [playlistWarning, setPlaylistWarning] = useState<string | null>(null);
  const [excludedTrackKeys, setExcludedTrackKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  const [job, setJob] = useState<RemixJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const excluded = useMemo(() => new Set(excludedTrackKeys), [excludedTrackKeys]);
  const includedTracks = useMemo(() => {
    if (!playlist) return [];
    return playlist.tracks.filter((track, index) => !excluded.has(trackKey(track.id, index)));
  }, [playlist, excluded]);

  const remixPlaylist = useMemo<PlaylistPayload | null>(() => {
    if (!playlist) return null;
    return { ...playlist, tracks: includedTracks };
  }, [playlist, includedTracks]);

  const estimatedMinutes = useMemo(() => {
    const count = includedTracks.length;
    if (!count) return 0;
    return Math.max(1, Math.round((count * 112 - Math.max(0, count - 1) * 12) / 60));
  }, [includedTracks.length]);

  const workflow = [
    { label: "Choose playlist", done: Boolean(playlist), active: !playlist },
    { label: "Review songs", done: Boolean(playlist && includedTracks.length >= 2), active: Boolean(playlist) && !job },
    { label: "Audio ready", done: audioReady, active: Boolean(playlist) && !audioReady },
    { label: "Create mix", done: Boolean(job), active: audioReady && !job },
    { label: "Download", done: job?.state === "complete", active: Boolean(job) && job?.state !== "complete" },
  ];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setRedirectUri(spotifyRedirectUri());
        if (new URLSearchParams(window.location.search).get("spotifySetup") === "1") setShowSpotifySetup(true);
        const completed = await completeSpotifyLoginFromUrl();
        const token = await ensureSpotifyAccessToken();
        if (cancelled) return;
        setSpotifyConnected(Boolean(token));
        setSpotifyClientId(getSpotifyClientId() ?? "");
        const pending = takePendingPlaylist();
        if (pending) setPlaylistUrl(pending);
        if (token) await loadAccountPlaylists(token);
        if (completed) setAuthNotice("Spotify connected. Your playlists are ready.");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Spotify connection failed.");
      } finally {
        if (!cancelled) setAuthBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!job?.job_id || !RUNNING_STATES.includes(job.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(
          personalEngineEndpoint(`/jobs/${job.job_id}`, `/api/remix/jobs?jobId=${job.job_id}`),
          { cache: "no-store" },
        );
        if (response.ok) setJob(await response.json() as RemixJob);
      } catch {
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.job_id, job?.state]);

  function scrollTo(id: string) {
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
  }

  async function loadAccountPlaylists(tokenOverride?: string) {
    const token = tokenOverride ?? await ensureSpotifyAccessToken();
    if (!token) return;
    setPlaylistsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/spotify/playlists", {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await readJsonResponse(response);
      if (!response.ok) {
        if (response.status === 401) setSpotifyConnected(false);
        throw new Error(String(body.error ?? "Could not load your Spotify playlists."));
      }
      setAccountPlaylists((body.playlists ?? []) as AccountPlaylist[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your Spotify playlists.");
    } finally {
      setPlaylistsLoading(false);
    }
  }

  async function connectSpotify(clientIdOverride?: string) {
    try {
      setError(null);
      setAuthNotice(null);
      const clientId = (clientIdOverride ?? spotifyClientId).trim();
      if (!clientId && !getSpotifyClientId()) {
        setShowSpotifySetup(true);
        return;
      }
      if (clientId) saveSpotifyClientId(clientId);
      rememberPendingPlaylist(playlistUrl);
      await beginSpotifyLogin(clientId || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start Spotify sign-in.");
    }
  }

  function disconnect() {
    disconnectSpotify();
    setSpotifyConnected(false);
    setAccountPlaylists([]);
    setPlaylist(null);
    setExcludedTrackKeys([]);
    setAudioReady(false);
    setPlaylistsOpen(false);
    setAuthNotice("Spotify disconnected.");
  }

  async function importPlaylist(urlOverride?: string) {
    const targetUrl = (urlOverride ?? playlistUrl).trim();
    if (!targetUrl) {
      setError("Choose a Spotify playlist or paste a playlist link first.");
      return;
    }

    if (urlOverride) {
      setPlaylistUrl(targetUrl);
      setPlaylistsOpen(false);
    }
    setLoading(true);
    setError(null);
    setPlaylistWarning(null);
    setPlaylist(null);
    setExcludedTrackKeys([]);
    setAudioReady(false);
    setJob(null);
    try {
      const token = await ensureSpotifyAccessToken();
      setSpotifyConnected(Boolean(token));
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;

      const response = await fetch("/api/spotify/playlist", {
        method: "POST",
        headers,
        body: JSON.stringify({ playlistUrl: targetUrl }),
      });
      const body = await readJsonResponse(response);
      if (!response.ok) {
        if (response.status === 401) setSpotifyConnected(false);
        throw new Error(String(body.error ?? body.detail ?? "Could not load that playlist."));
      }

      const loaded = body as unknown as PlaylistPayload;
      setPlaylist(loaded);
      if (loaded.truncated) {
        setPlaylistWarning("Spotify returned only a public preview. Reconnect the owning/collaborating Spotify account and reload before mixing.");
      } else {
        setAuthNotice(`${loaded.name} loaded with all ${loaded.tracks.length} songs.`);
      }
      scrollTo("review-section");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while loading the playlist.");
    } finally {
      setLoading(false);
    }
  }

  function toggleTrack(trackId: string, index: number) {
    const key = trackKey(trackId, index);
    setAudioReady(false);
    setExcludedTrackKeys((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  }

  async function startRemix() {
    if (!remixPlaylist || playlist?.truncated || starting) return;
    if (includedTracks.length < 2) {
      setError("Keep at least two songs in the mix.");
      return;
    }
    if (!audioReady) {
      setError("The selected songs are not all connected to remixable audio yet.");
      scrollTo("audio-source-stage");
      return;
    }

    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const response = await fetch(personalEngineEndpoint("/jobs", "/api/remix/jobs"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playlist: remixPlaylist,
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
            preview_seconds: 28,
          },
        }),
      });
      const body = await readJsonResponse(response);
      if (!response.ok) throw new Error(String(body.detail ?? body.error ?? "The remix engine could not start."));
      setJob(body as unknown as RemixJob);
      scrollTo("status-section");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the remix engine.");
    } finally {
      setStarting(false);
    }
  }

  function chooseAnotherPlaylist() {
    setPlaylist(null);
    setPlaylistWarning(null);
    setExcludedTrackKeys([]);
    setAudioReady(false);
    setJob(null);
    setError(null);
    scrollTo("start-section");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#start-section" aria-label="Playlist Remix Studio home"><div className="brandMark">R</div><span>Playlist Remix Studio</span></a>
        <div className="topActions">
          {playlist && <button className="textButton" onClick={chooseAnotherPlaylist}>Choose Another</button>}
          {spotifyConnected && <button className="textButton" onClick={disconnect}>Disconnect Spotify</button>}
          <span className={`connectionPill ${spotifyConnected ? "connected" : ""}`}><span className="connectionDot" />{authBusy ? "Checking Spotify…" : spotifyConnected ? "Spotify connected" : "Spotify not connected"}</span>
        </div>
      </header>

      <section className="hero" id="start-section">
        <div className="eyebrow">Personal automatic DJ</div>
        <h1>Choose a playlist. Trim the songs. Make the mix.</h1>
        <p className="sub">Spotify handles your playlist library and song identity. Your personal remix engine handles the heavy audio analysis, transitions, stems, mastering, artwork video and downloads.</p>
      </section>

      <nav className="progressNav" aria-label="Remix progress">
        {workflow.map((step, index) => <div className={`progressStep ${step.done ? "done" : ""} ${step.active ? "active" : ""}`} key={step.label}><span className="progressNumber">{step.done ? "✓" : index + 1}</span><span>{step.label}</span></div>)}
      </nav>

      <section className="card actionCard">
        {!spotifyConnected ? (
          <>
            <div className="actionStep"><div className="actionNumber">1</div><div className="actionCopy"><h2>Connect Spotify once</h2><p>After that, your playlists are available from one compact dropdown whenever you come back.</p></div><button className="primary actionButton" onClick={() => connectSpotify()}>Connect Spotify</button></div>
            {showSpotifySetup && (
              <div style={{ margin: "0 22px 22px", border: "1px solid #3d463b", borderRadius: 14, padding: 16, background: "rgba(20,24,19,.8)" }}>
                <strong style={{ display: "block", marginBottom: 6 }}>One-time Spotify app setup</strong>
                <p style={{ margin: "0 0 12px", color: "#9ca296", lineHeight: 1.55 }}>Add this exact redirect URI to your Spotify app, then paste its Client ID below. No Client Secret is needed.</p>
                <div style={{ padding: "10px 12px", borderRadius: 10, background: "#090b09", border: "1px solid #30362e", fontFamily: "monospace", wordBreak: "break-all", marginBottom: 12 }}>{redirectUri || "Loading site URL…"}</div>
                <div className="inputRow"><input className="urlInput" value={spotifyClientId} onChange={(event) => setSpotifyClientId(event.target.value)} placeholder="Paste Spotify Client ID" aria-label="Spotify Client ID" /><button className="primary" onClick={() => connectSpotify(spotifyClientId)} disabled={!spotifyClientId.trim()}>Save & Connect</button></div>
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: 22 }}>
            <button
              type="button"
              onClick={() => setPlaylistsOpen((value) => !value)}
              aria-expanded={playlistsOpen}
              style={{ width: "100%", border: "1px solid #30362e", background: "#0b0e0b", borderRadius: 14, padding: "15px 16px", color: "#f4f5ef", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, cursor: "pointer", textAlign: "left" }}
            >
              <div>
                <strong style={{ display: "block", fontSize: 17 }}>Your Spotify playlists</strong>
                <span style={{ color: "#9ca296", fontSize: 13 }}>{playlistsLoading ? "Loading…" : `${accountPlaylists.length} playlists · click to ${playlistsOpen ? "collapse" : "choose one"}`}</span>
              </div>
              <span style={{ fontSize: 22, transform: playlistsOpen ? "rotate(180deg)" : "none", transition: "transform .18s ease" }}>⌄</span>
            </button>

            {playlistsOpen && (
              <div style={{ marginTop: 10, border: "1px solid #30362e", borderRadius: 14, background: "#090b09", overflow: "hidden" }}>
                <div style={{ padding: "10px 12px", borderBottom: "1px solid #252b24", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <span style={{ color: "#9ca296", fontSize: 13 }}>Choose a playlist</span>
                  <button className="textButton" onClick={() => loadAccountPlaylists()} disabled={playlistsLoading}>{playlistsLoading ? "Refreshing…" : "Refresh"}</button>
                </div>
                <div style={{ maxHeight: 360, overflowY: "auto", padding: 8, display: "grid", gap: 6 }}>
                  {accountPlaylists.map((item) => (
                    <button key={item.id} onClick={() => importPlaylist(item.spotifyUrl)} disabled={loading} style={{ textAlign: "left", border: "1px solid transparent", background: "#0d110d", borderRadius: 10, padding: 9, color: "#f4f5ef", cursor: "pointer", width: "100%" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        {item.imageUrl ? <Image src={item.imageUrl} alt="" width={48} height={48} style={{ borderRadius: 8, objectFit: "cover" }} /> : <div style={{ width: 48, height: 48, borderRadius: 8, background: "#202620", flex: "0 0 auto" }} />}
                        <div style={{ minWidth: 0, flex: 1 }}><strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</strong><span style={{ color: "#9ca296", fontSize: 13 }}>{item.totalTracks ? `${item.totalTracks} songs` : item.ownerName}</span></div>
                        <span style={{ color: "#747b71" }}>›</span>
                      </div>
                    </button>
                  ))}
                  {!playlistsLoading && accountPlaylists.length === 0 && <div style={{ padding: 16, color: "#9ca296" }}>No playlists were returned by Spotify.</div>}
                </div>
              </div>
            )}
          </div>
        )}

        <details style={{ margin: "0 22px 20px" }}>
          <summary style={{ cursor: "pointer", color: "#b7bdb2" }}>Paste a Spotify playlist link instead</summary>
          <div className="inputRow" style={{ marginTop: 12 }}><input className="urlInput" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && importPlaylist()} placeholder="https://open.spotify.com/playlist/..." aria-label="Spotify playlist URL" disabled={loading} /><button className="secondary" onClick={() => importPlaylist()} disabled={loading || !playlistUrl.trim()}>{loading ? "Loading…" : "Load Link"}</button></div>
        </details>

        {authNotice && <div style={{ margin: "0 22px 18px", color: "#b8f7cd", lineHeight: 1.5 }}>{authNotice}</div>}
        {error && <div className="error" role="alert">{error}</div>}
      </section>

      {playlist && (
        <section className="card playlist" id="review-section">
          <div className="sectionKicker"><span>2</span> Review songs</div>
          <div className="playlistHead">{playlist.imageUrl ? <Image className="art" src={playlist.imageUrl} alt="" width={88} height={88} /> : <div className="art" />}<div className="playlistMeta"><h2>{playlist.name}</h2><p>{includedTracks.length} included · {excludedTrackKeys.length} excluded · {playlist.truncated ? "partial preview" : `about ${estimatedMinutes} min finished`}</p></div></div>
          {playlistWarning && <div style={{ margin: "0 22px 18px", border: "1px solid rgba(255,177,92,.35)", background: "rgba(255,177,92,.08)", borderRadius: 12, padding: 14, color: "#ffd2a0" }}>{playlistWarning}</div>}
          <div className="mixSummary"><div><span>In mix</span><strong>{includedTracks.length} songs</strong></div><div><span>Excluded</span><strong>{excludedTrackKeys.length}</strong></div><div><span>Audio</span><strong>{audioReady ? "Ready" : "Not ready"}</strong></div><div><span>Transitions</span><strong>Phrase-aligned</strong></div></div>

          <details className="trackDetails" open>
            <summary>Review tracks · press × to remove a song from this mix</summary>
            <div className="trackList">
              {playlist.tracks.map((track, index) => {
                const key = trackKey(track.id, index);
                const isExcluded = excluded.has(key);
                return <div className="track" key={key} style={{ opacity: isExcluded ? 0.38 : 1 }}><div className="trackIndex">{index + 1}</div>{track.imageUrl ? <Image className="trackArt" src={track.imageUrl} alt="" width={48} height={48} /> : <div className="trackArt" />}<div className="trackText"><div className="trackTitle" style={{ textDecoration: isExcluded ? "line-through" : "none" }}>{track.name}{track.explicit ? " · E" : ""}</div><div className="trackArtist">{track.artists.join(", ")}{track.album ? ` · ${track.album}` : ""}</div></div><div className="duration">{formatDuration(track.durationMs)}</div><button type="button" aria-label={isExcluded ? `Restore ${track.name}` : `Exclude ${track.name}`} title={isExcluded ? "Put song back" : "Remove from this mix"} onClick={() => toggleTrack(track.id, index)} style={{ width: 38, height: 38, borderRadius: 19, border: "1px solid #3b4439", background: isExcluded ? "#182019" : "#111511", color: isExcluded ? "#b8f7cd" : "#f4f5ef", fontSize: 20, cursor: "pointer" }}>{isExcluded ? "↩" : "×"}</button></div>;
              })}
            </div>
          </details>

          {!playlist.truncated && remixPlaylist && includedTracks.length >= 2 && <AudioSourceStageV2 playlist={remixPlaylist} onReadyChange={setAudioReady} />}

          <div className="createBar">
            <div><strong>{playlist.truncated ? "Load the full playlist first" : audioReady ? `${includedTracks.length} songs are ready` : "Connect the remix engine and finish audio matching"}</strong><span>{audioReady ? "The engine can now analyze the real audio and build the mix." : "The audio section above now gives a clear engine status instead of an unreadable-response error."}</span></div>
            <div className="createActions">
              {excludedTrackKeys.length > 0 && <button className="secondary" onClick={() => { setExcludedTrackKeys([]); setAudioReady(false); }}>Restore All</button>}
              <button className="secondary" onClick={chooseAnotherPlaylist}>Choose Different Playlist</button>
              <button className="primary createButton" onClick={startRemix} disabled={Boolean(playlist.truncated) || includedTracks.length < 2 || !audioReady || starting || RUNNING_STATES.includes(job?.state ?? "")}>
                {playlist.truncated ? "Full Playlist Needed" : !audioReady ? "Audio Not Ready" : starting ? "Starting Mix…" : RUNNING_STATES.includes(job?.state ?? "") ? "Mix Is Running" : "Create My Mix"}
              </button>
            </div>
          </div>
        </section>
      )}

      {job && (
        <section className="card jobCard" id="status-section" aria-live="polite">
          <div className="sectionKicker"><span>4</span> Mix status</div>
          <div className="jobHeader"><div><h2>{jobLabel(job.state)}</h2><p>{job.message}</p></div><div className={`statusDot ${job.state}`} aria-label={job.state} /></div>
          {RUNNING_STATES.includes(job.state) && <div className="renderSteps">{["Confirming audio", "Mapping phrases", "Planning transitions", "Rendering transitions", "Mastering"].map((label, index) => <div className="renderStep" key={label}><span>{index + 1}</span>{label}</div>)}</div>}
          {job.missing_tracks && job.missing_tracks.length > 0 && <div className="missing"><strong>These songs still need audio:</strong><div>{job.missing_tracks.slice(0, 12).join(" • ")}{job.missing_tracks.length > 12 ? ` • +${job.missing_tracks.length - 12} more` : ""}</div><button className="primary retryButton" onClick={() => scrollTo("audio-source-stage")}>Back to Audio Sources</button></div>}
          {job.state === "failed" && <div className="jobActions"><button className="secondary" onClick={chooseAnotherPlaylist}>Choose Another Playlist</button><button className="primary" onClick={startRemix}>Retry Mix</button></div>}
          {job.state === "complete" && <div className="downloadArea"><div><strong>Your mix is finished.</strong><span>Download the mastered audio or the 16:9 artwork video.</span></div><div className="downloadButtons">{job.output_audio && <a className="secondary buttonLink" href={personalEngineDownload(job.job_id, "audio")}>Download Audio</a>}{job.output_video && <a className="primary buttonLink" href={personalEngineDownload(job.job_id, "video")}>Download Video</a>}</div></div>}
        </section>
      )}

      <p className="legal">Spotify supplies playlist identity and metadata. The audio engine must receive an audio source it is allowed to analyze and render; Spotify and YouTube account APIs do not expose the raw full-song audio stream to this app.</p>
    </main>
  );
}
