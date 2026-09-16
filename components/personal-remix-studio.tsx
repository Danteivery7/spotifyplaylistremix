"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
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
    case "resolving": return "Finding audio";
    case "analyzing": return "Mapping the music";
    case "planning": return "Planning the mix";
    case "rendering": return "Building transitions";
    case "mastering": return "Mastering the final mix";
    case "complete": return "Ready to download";
    case "blocked": return "Audio source needed";
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
    const clean = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(clean ? `The site returned a non-JSON error: ${clean}` : `The site returned an unreadable response (${response.status}).`);
  }
}

export default function PersonalRemixStudio() {
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [spotifyClientId, setSpotifyClientId] = useState("");
  const [showSpotifySetup, setShowSpotifySetup] = useState(false);
  const [redirectUri, setRedirectUri] = useState("");
  const [authBusy, setAuthBusy] = useState(true);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [accountPlaylists, setAccountPlaylists] = useState<AccountPlaylist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlist, setPlaylist] = useState<PlaylistPayload | null>(null);
  const [playlistWarning, setPlaylistWarning] = useState<string | null>(null);
  const [excludedTrackKeys, setExcludedTrackKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const [job, setJob] = useState<RemixJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const excluded = useMemo(() => new Set(excludedTrackKeys), [excludedTrackKeys]);
  const includedTracks = useMemo(() => {
    if (!playlist) return [];
    return playlist.tracks.filter((track, index) => !excluded.has(trackKey(track.id, index)));
  }, [playlist, excluded]);

  const estimatedMinutes = useMemo(() => {
    const count = includedTracks.length;
    if (!count) return 0;
    return Math.max(1, Math.round((count * 112 - Math.max(0, count - 1) * 12) / 60));
  }, [includedTracks.length]);

  const workflow = [
    { label: "Choose playlist", done: Boolean(playlist), active: !playlist },
    { label: "Review songs", done: Boolean(playlist && includedTracks.length >= 2), active: Boolean(playlist) && !job },
    { label: "Create mix", done: Boolean(job), active: Boolean(playlist) && !job },
    { label: "Download", done: job?.state === "complete", active: Boolean(job) && job?.state !== "complete" },
  ];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setRedirectUri(spotifyRedirectUri());
        const setupRequested = new URLSearchParams(window.location.search).get("spotifySetup") === "1";
        if (setupRequested) setShowSpotifySetup(true);
        const completed = await completeSpotifyLoginFromUrl();
        const token = await ensureSpotifyAccessToken();
        if (cancelled) return;
        setSpotifyConnected(Boolean(token));
        setSpotifyClientId(getSpotifyClientId() ?? "");
        const pending = takePendingPlaylist();
        if (pending) setPlaylistUrl(pending);
        if (token) await loadAccountPlaylists(token);
        if (completed) setAuthNotice("Spotify connected. Your playlists are ready below.");
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
        const response = await fetch(`/api/remix/jobs?jobId=${job.job_id}`, { cache: "no-store" });
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
    setAuthNotice("Spotify disconnected. You can still paste a public playlist link.");
  }

  async function importPlaylist(urlOverride?: string) {
    const targetUrl = (urlOverride ?? playlistUrl).trim();
    if (!targetUrl) {
      setError("Choose a Spotify playlist or paste a playlist link first.");
      return;
    }

    if (urlOverride) setPlaylistUrl(targetUrl);
    setLoading(true);
    setError(null);
    setPlaylistWarning(null);
    setPlaylist(null);
    setExcludedTrackKeys([]);
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
        setPlaylistWarning("This is only Spotify's public preview. Connect the owning/collaborating account and reload it before mixing.");
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
    setExcludedTrackKeys((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  }

  async function startRemix() {
    if (!playlist || playlist.truncated || starting) return;
    if (includedTracks.length < 2) {
      setError("Keep at least two songs in the mix.");
      return;
    }

    setStarting(true);
    setError(null);
    setJob(null);
    try {
      const remixPlaylist: PlaylistPayload = { ...playlist, tracks: includedTracks };
      const response = await fetch("/api/remix/jobs", {
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
          {playlist && <button className="textButton" onClick={chooseAnotherPlaylist}>Choose Another</button>}
          {spotifyConnected && <button className="textButton" onClick={disconnect}>Disconnect Spotify</button>}
          <span className={`connectionPill ${spotifyConnected ? "connected" : ""}`}>
            <span className="connectionDot" />
            {authBusy ? "Checking Spotify…" : spotifyConnected ? "Spotify connected" : "Spotify not connected"}
          </span>
        </div>
      </header>

      <section className="hero" id="start-section">
        <div className="eyebrow">Personal automatic DJ</div>
        <h1>Pick a playlist. Remove anything you do not want. Make the mix.</h1>
        <p className="sub">Once Spotify is connected, your playlists live here. No copy-and-paste is required for your normal workflow.</p>
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
        {!spotifyConnected ? (
          <>
            <div className="actionStep">
              <div className="actionNumber">1</div>
              <div className="actionCopy">
                <h2>Connect Spotify once</h2>
                <p>After that, this page can show your playlists directly whenever you come back.</p>
              </div>
              <button className="primary actionButton" onClick={() => connectSpotify()}>Connect Spotify</button>
            </div>

            {showSpotifySetup && (
              <div style={{ margin: "0 0 22px 62px", border: "1px solid #3d463b", borderRadius: 14, padding: 16, background: "rgba(20,24,19,.8)" }}>
                <strong style={{ display: "block", marginBottom: 6 }}>One-time Spotify app setup</strong>
                <p style={{ margin: "0 0 12px", color: "#9ca296", lineHeight: 1.55 }}>Add this exact redirect URI to your Spotify app, then paste its Client ID below. No Client Secret is needed.</p>
                <div style={{ padding: "10px 12px", borderRadius: 10, background: "#090b09", border: "1px solid #30362e", fontFamily: "monospace", wordBreak: "break-all", marginBottom: 12 }}>{redirectUri || "Loading site URL…"}</div>
                <div className="inputRow">
                  <input className="urlInput" value={spotifyClientId} onChange={(event) => setSpotifyClientId(event.target.value)} placeholder="Paste Spotify Client ID" aria-label="Spotify Client ID" />
                  <button className="primary" onClick={() => connectSpotify(spotifyClientId)} disabled={!spotifyClientId.trim()}>Save & Connect</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <div>
                <h2 style={{ margin: "0 0 4px" }}>Your Spotify playlists</h2>
                <p style={{ margin: 0, color: "#9ca296" }}>Click one and the full track list loads for review.</p>
              </div>
              <button className="secondary" onClick={() => loadAccountPlaylists()} disabled={playlistsLoading}>{playlistsLoading ? "Refreshing…" : "Refresh Playlists"}</button>
            </div>

            {playlistsLoading && !accountPlaylists.length ? <div style={{ color: "#9ca296" }}>Loading your Spotify playlists…</div> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 }}>
                {accountPlaylists.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => importPlaylist(item.spotifyUrl)}
                    disabled={loading}
                    style={{ textAlign: "left", border: "1px solid #30362e", background: "#0b0e0b", borderRadius: 14, padding: 12, color: "#f4f5ef", cursor: "pointer", minHeight: 94 }}
                  >
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      {item.imageUrl ? <Image src={item.imageUrl} alt="" width={58} height={58} style={{ borderRadius: 9, objectFit: "cover" }} /> : <div style={{ width: 58, height: 58, borderRadius: 9, background: "#202620", flex: "0 0 auto" }} />}
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</strong>
                        <span style={{ color: "#9ca296", fontSize: 13 }}>{item.totalTracks ? `${item.totalTracks} songs` : item.ownerName}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="actionDivider" />
        <div className="actionStep">
          <div className="actionNumber">↗</div>
          <div className="actionCopy">
            <h2>Or paste any Spotify playlist link</h2>
            <p>This stays available as a fallback for a playlist that is not already shown above.</p>
            <div className="inputRow">
              <input className="urlInput" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} onKeyDown={(event) => event.key === "Enter" && importPlaylist()} placeholder="https://open.spotify.com/playlist/..." aria-label="Spotify playlist URL" disabled={loading} />
              <button className="secondary" onClick={() => importPlaylist()} disabled={loading || !playlistUrl.trim()}>{loading ? "Loading…" : "Load Link"}</button>
            </div>
          </div>
        </div>

        {authNotice && <div style={{ margin: "0 22px 18px", color: "#b8f7cd", lineHeight: 1.5 }}>{authNotice}</div>}
        {error && <div className="error" role="alert">{error}</div>}
      </section>

      {playlist && (
        <section className="card playlist" id="review-section">
          <div className="sectionKicker"><span>2</span> Review songs</div>
          <div className="playlistHead">
            {playlist.imageUrl ? <Image className="art" src={playlist.imageUrl} alt="" width={88} height={88} /> : <div className="art" />}
            <div className="playlistMeta">
              <h2>{playlist.name}</h2>
              <p>{includedTracks.length} included · {excludedTrackKeys.length} excluded · {playlist.truncated ? "partial preview" : `about ${estimatedMinutes} min finished`}</p>
            </div>
          </div>

          {playlistWarning && (
            <div style={{ margin: "0 22px 18px", border: "1px solid rgba(255,177,92,.35)", background: "rgba(255,177,92,.08)", borderRadius: 12, padding: 14, color: "#ffd2a0" }}>{playlistWarning}</div>
          )}

          <div className="mixSummary">
            <div><span>In mix</span><strong>{includedTracks.length} songs</strong></div>
            <div><span>Excluded</span><strong>{excludedTrackKeys.length}</strong></div>
            <div><span>Song sections</span><strong>1:32–2:22 each</strong></div>
            <div><span>Transitions</span><strong>Phrase-aligned</strong></div>
          </div>

          <details className="trackDetails" open>
            <summary>Review tracks · press × to remove a song from this mix</summary>
            <div className="trackList">
              {playlist.tracks.map((track, index) => {
                const key = trackKey(track.id, index);
                const isExcluded = excluded.has(key);
                return (
                  <div className="track" key={key} style={{ opacity: isExcluded ? 0.38 : 1 }}>
                    <div className="trackIndex">{index + 1}</div>
                    {track.imageUrl ? <Image className="trackArt" src={track.imageUrl} alt="" width={48} height={48} /> : <div className="trackArt" />}
                    <div className="trackText">
                      <div className="trackTitle" style={{ textDecoration: isExcluded ? "line-through" : "none" }}>{track.name}{track.explicit ? " · E" : ""}</div>
                      <div className="trackArtist">{track.artists.join(", ")}{track.album ? ` · ${track.album}` : ""}</div>
                    </div>
                    <div className="duration">{formatDuration(track.durationMs)}</div>
                    <button
                      type="button"
                      aria-label={isExcluded ? `Restore ${track.name}` : `Exclude ${track.name}`}
                      title={isExcluded ? "Put song back" : "Remove from this mix"}
                      onClick={() => toggleTrack(track.id, index)}
                      style={{ width: 38, height: 38, borderRadius: 19, border: "1px solid #3b4439", background: isExcluded ? "#182019" : "#111511", color: isExcluded ? "#b8f7cd" : "#f4f5ef", fontSize: 20, cursor: "pointer" }}
                    >{isExcluded ? "↩" : "×"}</button>
                  </div>
                );
              })}
            </div>
          </details>

          <div className="createBar">
            <div>
              <strong>{playlist.truncated ? "Load the full playlist first" : `${includedTracks.length} songs ready for this mix`}</strong>
              <span>{excludedTrackKeys.length ? `${excludedTrackKeys.length} songs will be skipped completely.` : "Everything is included. X out anything you do not want."}</span>
            </div>
            <div className="createActions">
              {excludedTrackKeys.length > 0 && <button className="secondary" onClick={() => setExcludedTrackKeys([])}>Restore All</button>}
              <button className="secondary" onClick={chooseAnotherPlaylist}>Choose Different Playlist</button>
              <button className="primary createButton" onClick={startRemix} disabled={playlist.truncated || includedTracks.length < 2 || starting || RUNNING_STATES.includes(job?.state ?? "")}>
                {starting ? "Starting Mix…" : RUNNING_STATES.includes(job?.state ?? "") ? "Mix Is Running" : "Create My Mix"}
              </button>
            </div>
          </div>
        </section>
      )}

      {job && (
        <section className="card jobCard" id="status-section" aria-live="polite">
          <div className="sectionKicker"><span>3</span> Mix status</div>
          <div className="jobHeader"><div><h2>{jobLabel(job.state)}</h2><p>{job.message}</p></div><div className={`statusDot ${job.state}`} aria-label={job.state} /></div>

          {RUNNING_STATES.includes(job.state) && (
            <div className="renderSteps">
              {["Finding audio", "Mapping phrases", "Planning transitions", "Rendering transitions", "Mastering"].map((label, index) => (
                <div className="renderStep" key={label}><span>{index + 1}</span>{label}</div>
              ))}
            </div>
          )}

          {job.missing_tracks && job.missing_tracks.length > 0 && (
            <div className="missing">
              <strong>These selected songs still need a remixable audio source:</strong>
              <div>{job.missing_tracks.slice(0, 12).join(" • ")}{job.missing_tracks.length > 12 ? ` • +${job.missing_tracks.length - 12} more` : ""}</div>
            </div>
          )}

          {job.state === "failed" && <div className="jobActions"><button className="secondary" onClick={chooseAnotherPlaylist}>Choose Another Playlist</button><button className="primary" onClick={startRemix}>Retry Mix</button></div>}

          {job.state === "complete" && (
            <div className="downloadArea">
              <div><strong>Your mix is finished.</strong><span>Download the mastered audio or the 16:9 waveform video.</span></div>
              <div className="downloadButtons">
                {job.output_audio && <a className="secondary buttonLink" href={`/api/remix/download?jobId=${job.job_id}&kind=audio`}>Download Audio</a>}
                {job.output_video && <a className="primary buttonLink" href={`/api/remix/download?jobId=${job.job_id}&kind=video`}>Download Video</a>}
              </div>
            </div>
          )}
        </section>
      )}

      <p className="legal">Spotify supplies playlist identity and metadata. Songs you X out are never sent to the remix engine. The engine processes only audio sources you are authorized to use.</p>
    </main>
  );
}
