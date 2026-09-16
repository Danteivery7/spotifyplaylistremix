"use client";

import { useEffect, useMemo, useState } from "react";
import { ensureSpotifyAccessToken } from "@/lib/spotify-pkce";
import type { PlaylistPayload } from "@/lib/types";
import type { YouTubeMatchResult, YouTubeVideoRecord } from "@/lib/youtube";

type Mode = "spotify" | "playlist" | "video";
type YouTubePlaylistPayload = {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  url: string;
  videos: YouTubeVideoRecord[];
  missingCount: number;
};

const KEY_STORAGE = "spr_youtube_api_key";

function duration(seconds: number) {
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

async function responseJson(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`The site returned an unreadable YouTube response (${response.status}).`);
  }
}

export default function YouTubeSourceResolver() {
  const [mode, setMode] = useState<Mode>("spotify");
  const [apiKey, setApiKey] = useState("");
  const [serverConfigured, setServerConfigured] = useState(false);
  const [spotifyUrl, setSpotifyUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [playlistName, setPlaylistName] = useState("");
  const [matches, setMatches] = useState<YouTubeMatchResult[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [youtubePlaylist, setYoutubePlaylist] = useState<YouTubePlaylistPayload | null>(null);
  const [singleVideo, setSingleVideo] = useState<YouTubeVideoRecord | null>(null);

  useEffect(() => {
    setApiKey(window.localStorage.getItem(KEY_STORAGE) ?? "");
    fetch("/api/youtube/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => setServerConfigured(Boolean(body.configured)))
      .catch(() => setServerConfigured(false));
  }, []);

  const needsReview = useMemo(() => matches.filter((match) => !match.best || match.best.confidence < 70).length, [matches]);
  const confirmed = matches.length - needsReview;

  function keyHeaders(extra?: Record<string, string>) {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (apiKey.trim()) headers["x-youtube-api-key"] = apiKey.trim();
    return headers;
  }

  function rememberKey(value: string) {
    const trimmed = value.trim();
    setApiKey(trimmed);
    if (trimmed) window.localStorage.setItem(KEY_STORAGE, trimmed);
    else window.localStorage.removeItem(KEY_STORAGE);
  }

  function resetResults() {
    setError(null);
    setProgress("");
    setMatches([]);
    setSelected({});
    setYoutubePlaylist(null);
    setSingleVideo(null);
  }

  async function matchSpotify() {
    if (!spotifyUrl.trim()) return setError("Paste the Spotify playlist you want matched to YouTube.");
    if (!serverConfigured && !apiKey.trim()) return setError("Add a YouTube Data API key first.");
    setBusy(true);
    resetResults();
    try {
      const token = await ensureSpotifyAccessToken();
      const spotifyHeaders: Record<string, string> = { "content-type": "application/json" };
      if (token) spotifyHeaders.authorization = `Bearer ${token}`;
      setProgress("Loading the complete Spotify playlist…");
      const spotifyResponse = await fetch("/api/spotify/playlist", {
        method: "POST",
        headers: spotifyHeaders,
        body: JSON.stringify({ playlistUrl: spotifyUrl.trim() }),
      });
      const spotifyBody = await responseJson(spotifyResponse);
      if (!spotifyResponse.ok) throw new Error(String(spotifyBody.error ?? "Could not load the Spotify playlist."));
      const playlist = spotifyBody as unknown as PlaylistPayload;
      if (playlist.truncated) throw new Error("Connect Spotify first so the full playlist is available before YouTube matching.");
      setPlaylistName(playlist.name);

      const all: YouTubeMatchResult[] = [];
      for (let index = 0; index < playlist.tracks.length; index += 10) {
        const batch = playlist.tracks.slice(index, index + 10);
        setProgress(`Finding YouTube versions ${index + 1}–${Math.min(index + batch.length, playlist.tracks.length)} of ${playlist.tracks.length}…`);
        const response = await fetch("/api/youtube/match", {
          method: "POST",
          headers: keyHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ tracks: batch }),
        });
        const body = await responseJson(response);
        if (!response.ok) throw new Error(String(body.error ?? "YouTube matching failed."));
        const results = (body.results ?? []) as YouTubeMatchResult[];
        all.push(...results);
        setMatches([...all]);
        setSelected((current) => {
          const next = { ...current };
          for (const result of results) if (result.best) next[result.trackId] = result.best.id;
          return next;
        });
      }
      setProgress(`Matched ${all.length} Spotify songs against YouTube.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Spotify to YouTube matching failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadYouTubePlaylist() {
    if (!youtubeUrl.trim()) return setError("Paste a public YouTube playlist link first.");
    if (!serverConfigured && !apiKey.trim()) return setError("Add a YouTube Data API key first.");
    setBusy(true);
    resetResults();
    try {
      setProgress("Loading the YouTube playlist…");
      const response = await fetch("/api/youtube/playlist", {
        method: "POST",
        headers: keyHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ url: youtubeUrl.trim() }),
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(String(body.error ?? "Could not load that YouTube playlist."));
      const loaded = body as unknown as YouTubePlaylistPayload;
      setYoutubePlaylist(loaded);
      setProgress(`Loaded ${loaded.videos.length} YouTube videos${loaded.missingCount ? ` · ${loaded.missingCount} unavailable` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "YouTube playlist import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function loadVideo() {
    if (!youtubeUrl.trim()) return setError("Paste a YouTube video link first.");
    if (!serverConfigured && !apiKey.trim()) return setError("Add a YouTube Data API key first.");
    setBusy(true);
    resetResults();
    try {
      setProgress("Reading the YouTube video…");
      const response = await fetch("/api/youtube/video", {
        method: "POST",
        headers: keyHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ url: youtubeUrl.trim() }),
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(String(body.error ?? "Could not load that YouTube video."));
      setSingleVideo(body as unknown as YouTubeVideoRecord);
      setProgress("YouTube video identified.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "YouTube video import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ width: "min(1120px, calc(100% - 32px))", margin: "0 auto 80px" }} id="youtube-source-resolver">
      <div className="card" style={{ padding: 24 }}>
        <div className="sectionKicker"><span>YT</span> YouTube source resolver</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ maxWidth: 720 }}>
            <h2 style={{ margin: "0 0 8px" }}>Match Spotify songs to YouTube, load a YouTube playlist, or add one video.</h2>
            <p style={{ margin: 0, color: "#9ca296", lineHeight: 1.6 }}>The matcher favors artist/title accuracy, close duration, artist/Topic channels and official audio. Explicit Spotify tracks prefer explicit/original cues and penalize clean or radio-edit uploads.</p>
          </div>
          <div className="successBadge">YouTube matching build</div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "22px 0" }}>
          {([[
            "spotify", "Spotify → YouTube"
          ], ["playlist", "YouTube Playlist"], ["video", "YouTube Video"]] as Array<[Mode, string]>).map(([value, label]) => (
            <button key={value} className={mode === value ? "primary" : "secondary"} onClick={() => { setMode(value); resetResults(); }}>{label}</button>
          ))}
        </div>

        {!serverConfigured && (
          <div style={{ border: "1px solid #3d463b", borderRadius: 14, padding: 16, marginBottom: 18, background: "rgba(20,24,19,.8)" }}>
            <strong style={{ display: "block", marginBottom: 6 }}>One-time YouTube Data API setup</strong>
            <p style={{ margin: "0 0 12px", color: "#9ca296", lineHeight: 1.55 }}>Paste a YouTube Data API v3 key here. It stays in this browser. For a permanent deployment, you can instead add <code>YOUTUBE_API_KEY</code> to Cloudflare.</p>
            <div className="inputRow">
              <input className="urlInput" value={apiKey} onChange={(event) => rememberKey(event.target.value)} placeholder="Paste YouTube Data API key" aria-label="YouTube Data API key" type="password" />
              <a className="secondary buttonLink" href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer">Open Google Cloud ↗</a>
            </div>
          </div>
        )}

        {mode === "spotify" ? (
          <div className="inputRow">
            <input className="urlInput" value={spotifyUrl} onChange={(event) => setSpotifyUrl(event.target.value)} placeholder="https://open.spotify.com/playlist/..." aria-label="Spotify playlist for YouTube matching" />
            <button className="primary" onClick={matchSpotify} disabled={busy}>{busy ? "Matching…" : "Find YouTube Matches"}</button>
          </div>
        ) : (
          <div className="inputRow">
            <input className="urlInput" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder={mode === "playlist" ? "https://www.youtube.com/playlist?list=..." : "https://www.youtube.com/watch?v=..."} aria-label="YouTube URL" />
            <button className="primary" onClick={mode === "playlist" ? loadYouTubePlaylist : loadVideo} disabled={busy}>{busy ? "Loading…" : mode === "playlist" ? "Load YouTube Playlist" : "Add YouTube Video"}</button>
          </div>
        )}

        {progress && <div style={{ marginTop: 14, color: "#b8f7cd" }}>{progress}</div>}
        {error && <div className="error" role="alert" style={{ marginTop: 14 }}>{error}</div>}

        {matches.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="mixSummary">
              <div><span>Spotify playlist</span><strong>{playlistName || "Loaded"}</strong></div>
              <div><span>Matched</span><strong>{confirmed} confident</strong></div>
              <div><span>Needs review</span><strong>{needsReview}</strong></div>
              <div><span>Selection</span><strong>{Object.keys(selected).length}/{matches.length}</strong></div>
            </div>
            <details className="trackDetails" open>
              <summary>Review YouTube matches</summary>
              <div className="trackList">
                {matches.map((match, index) => {
                  const chosenId = selected[match.trackId] ?? match.best?.id ?? "";
                  const chosen = match.candidates.find((candidate) => candidate.id === chosenId) ?? match.best;
                  return (
                    <div className="track" key={`${match.trackId}-${index}`} style={{ alignItems: "flex-start" }}>
                      <div className="trackIndex">{index + 1}</div>
                      <div className="trackText" style={{ minWidth: 0 }}>
                        <div className="trackTitle">{match.trackName}{match.explicit ? " · E" : ""}</div>
                        <div className="trackArtist">{match.artists.join(", ")}</div>
                        {match.candidates.length ? (
                          <select value={chosenId} onChange={(event) => setSelected((current) => ({ ...current, [match.trackId]: event.target.value }))} style={{ width: "100%", marginTop: 8, background: "#090b09", color: "#f4f5ef", border: "1px solid #30362e", borderRadius: 9, padding: "9px 10px" }}>
                            {match.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.confidence}% · {candidate.title} — {candidate.channelTitle}</option>)}
                          </select>
                        ) : <div style={{ marginTop: 8, color: "#ffb15c" }}>No match found</div>}
                        {chosen && <div style={{ marginTop: 7, color: "#9ca296", fontSize: 13 }}>{chosen.reasons.slice(0, 3).join(" · ")}</div>}
                      </div>
                      {chosen && <div style={{ textAlign: "right", minWidth: 90 }}><strong>{chosen.confidence}%</strong><div className="duration">{duration(chosen.durationSeconds)}</div><a href={chosen.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#b8f7cd" }}>Open ↗</a></div>}
                    </div>
                  );
                })}
              </div>
            </details>
          </div>
        )}

        {youtubePlaylist && (
          <div style={{ marginTop: 24 }}>
            <h3 style={{ marginBottom: 6 }}>{youtubePlaylist.name}</h3>
            <div style={{ color: "#9ca296", marginBottom: 14 }}>{youtubePlaylist.videos.length} available videos{youtubePlaylist.missingCount ? ` · ${youtubePlaylist.missingCount} unavailable/private` : ""}</div>
            <details className="trackDetails" open>
              <summary>See all videos</summary>
              <div className="trackList">{youtubePlaylist.videos.map((video, index) => <div className="track" key={video.id}><div className="trackIndex">{index + 1}</div><div className="trackText"><div className="trackTitle">{video.title}</div><div className="trackArtist">{video.channelTitle}</div></div><div><div className="duration">{duration(video.durationSeconds)}</div><a href={video.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#b8f7cd" }}>Open ↗</a></div></div>)}</div>
            </details>
          </div>
        )}

        {singleVideo && (
          <div style={{ marginTop: 24, border: "1px solid #30362e", borderRadius: 14, padding: 16 }}>
            <strong>{singleVideo.title}</strong>
            <div style={{ color: "#9ca296", marginTop: 5 }}>{singleVideo.channelTitle} · {duration(singleVideo.durationSeconds)}</div>
            <a href={singleVideo.url} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 10, color: "#b8f7cd" }}>Open on YouTube ↗</a>
          </div>
        )}

        <div style={{ marginTop: 22, borderTop: "1px solid #262b24", paddingTop: 16, color: "#9ca296", fontSize: 13, lineHeight: 1.55 }}>
          YouTube matching identifies the correct media source and lets you verify versions. Remix rendering still requires audio the app is authorized to process, such as uploaded files, licensed/download-enabled sources, or media you own.
        </div>
      </div>
    </section>
  );
}
