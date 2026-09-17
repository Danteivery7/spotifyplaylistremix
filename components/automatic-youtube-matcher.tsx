"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PlaylistPayload, PlaylistTrack } from "@/lib/types";
import type { YouTubeMatchResult } from "@/lib/youtube";

type Props = {
  playlist: PlaylistPayload;
};

type CacheEntry = {
  savedAt: number;
  fingerprint: string;
  result: YouTubeMatchResult;
};

type MatchCache = Record<string, CacheEntry>;

const KEY_STORAGE = "spr_youtube_api_key";
const CACHE_STORAGE = "spr_youtube_auto_match_cache_v1";
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function trackFingerprint(track: PlaylistTrack) {
  return [
    track.id,
    track.name,
    track.artists.join("|"),
    String(track.durationMs),
    track.explicit ? "explicit" : "standard",
  ].join("::");
}

function loadCache(): MatchCache {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CACHE_STORAGE) ?? "{}") as MatchCache;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed).filter(([, entry]) => entry && now - entry.savedAt < CACHE_MAX_AGE_MS),
    );
  } catch {
    return {};
  }
}

function saveCache(cache: MatchCache) {
  try {
    window.localStorage.setItem(CACHE_STORAGE, JSON.stringify(cache));
  } catch {
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`YouTube returned an unreadable response (${response.status}).`);
  }
}

export default function AutomaticYouTubeMatcher({ playlist }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [serverConfigured, setServerConfigured] = useState(false);
  const [configurationChecked, setConfigurationChecked] = useState(false);
  const [results, setResults] = useState<YouTubeMatchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  const playlistFingerprint = useMemo(
    () => playlist.tracks.map(trackFingerprint).join("||"),
    [playlist],
  );

  useEffect(() => {
    setApiKey(window.localStorage.getItem(KEY_STORAGE) ?? "");
    fetch("/api/youtube/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body) => setServerConfigured(Boolean(body.configured)))
      .catch(() => setServerConfigured(false))
      .finally(() => setConfigurationChecked(true));
  }, []);

  async function matchAll(force = false, keyOverride?: string) {
    const requestId = ++runId.current;
    const key = (keyOverride ?? apiKey).trim();
    if (!serverConfigured && !key) {
      setResults([]);
      setProgress("");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const cache = loadCache();
      const resolved = new Map<string, YouTubeMatchResult>();
      const missing: PlaylistTrack[] = [];

      for (const track of playlist.tracks) {
        const fingerprint = trackFingerprint(track);
        const cached = cache[track.id];
        if (!force && cached?.fingerprint === fingerprint) {
          resolved.set(track.id, cached.result);
        } else {
          missing.push(track);
        }
      }

      const publish = () => {
        if (runId.current !== requestId) return;
        setResults(playlist.tracks.map((track) => resolved.get(track.id)).filter((value): value is YouTubeMatchResult => Boolean(value)));
      };
      publish();

      for (let index = 0; index < missing.length; index += 10) {
        if (runId.current !== requestId) return;
        const batch = missing.slice(index, index + 10);
        setProgress(`Finding YouTube versions ${Math.min(index + 1, missing.length)}–${Math.min(index + batch.length, missing.length)} of ${missing.length} uncached songs…`);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (key) headers["x-youtube-api-key"] = key;
        const response = await fetch("/api/youtube/match", {
          method: "POST",
          headers,
          body: JSON.stringify({ tracks: batch }),
        });
        const body = await readJson(response);
        if (!response.ok) throw new Error(String(body.error ?? "YouTube matching failed."));
        const batchResults = (body.results ?? []) as YouTubeMatchResult[];
        for (const result of batchResults) {
          const sourceTrack = batch.find((track) => track.id === result.trackId);
          if (!sourceTrack) continue;
          resolved.set(result.trackId, result);
          cache[result.trackId] = {
            savedAt: Date.now(),
            fingerprint: trackFingerprint(sourceTrack),
            result,
          };
        }
        saveCache(cache);
        publish();
      }

      const finalResults = playlist.tracks.map((track) => resolved.get(track.id)).filter((value): value is YouTubeMatchResult => Boolean(value));
      if (runId.current === requestId) {
        setResults(finalResults);
        const strong = finalResults.filter((result) => result.best && result.best.confidence >= 70).length;
        setProgress(`${strong}/${playlist.tracks.length} songs have strong YouTube matches. Results are cached for future mixes.`);
      }
    } catch (err) {
      if (runId.current === requestId) setError(err instanceof Error ? err.message : "Automatic YouTube matching failed.");
    } finally {
      if (runId.current === requestId) setBusy(false);
    }
  }

  useEffect(() => {
    if (!configurationChecked || !playlist.tracks.length) return;
    void matchAll(false);
    return () => { runId.current += 1; };
    // playlistFingerprint intentionally represents included tracks and their matching metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurationChecked, serverConfigured, apiKey, playlistFingerprint]);

  function saveKey() {
    const clean = apiKey.trim();
    if (clean) window.localStorage.setItem(KEY_STORAGE, clean);
    else window.localStorage.removeItem(KEY_STORAGE);
    setApiKey(clean);
    void matchAll(true, clean);
  }

  const strong = results.filter((result) => result.best && result.best.confidence >= 70).length;
  const review = results.filter((result) => !result.best || result.best.confidence < 70);

  return (
    <div style={{ margin: "18px 22px 0", border: "1px solid #30362e", borderRadius: 16, padding: 18, background: "rgba(10,13,10,.72)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ maxWidth: 760 }}>
          <strong style={{ display: "block", fontSize: 18, marginBottom: 4 }}>Automatic YouTube matches</strong>
          <span style={{ color: "#9ca296", lineHeight: 1.55 }}>
            Every included Spotify song is matched to its strongest YouTube video automatically. Official/Topic uploads, duration, artist, explicit version and title are all scored, and cached matches are reused to save API quota.
          </span>
        </div>
        <div className="successBadge" style={{ opacity: strong === playlist.tracks.length && playlist.tracks.length > 0 ? 1 : .75 }}>
          {busy ? "Matching…" : `${strong}/${playlist.tracks.length} strong`}
        </div>
      </div>

      {configurationChecked && !serverConfigured && !apiKey.trim() && (
        <div style={{ marginTop: 14, border: "1px solid #3b4439", borderRadius: 12, padding: 14, background: "#090b09" }}>
          <strong style={{ display: "block", marginBottom: 5 }}>Add your YouTube Data API key once</strong>
          <div style={{ color: "#9ca296", fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
            You can use the same YouTube Data API v3 key as your shared-music/Hangout-style project if that Google Cloud key is allowed for this site. It stays in this browser unless you configure YOUTUBE_API_KEY on the server.
          </div>
          <div className="inputRow">
            <input className="urlInput" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="YouTube Data API v3 key" aria-label="YouTube Data API key" />
            <button className="primary" onClick={saveKey} disabled={!apiKey.trim()}>Save & Match</button>
          </div>
        </div>
      )}

      {progress && <div style={{ marginTop: 12, color: "#b8f7cd", fontSize: 14 }}>{progress}</div>}
      {error && <div className="error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      {results.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", color: "#c7cec2" }}>
            Review YouTube matches · {review.length ? `${review.length} need attention` : "all look strong"}
          </summary>
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {results.map((result) => (
              <div key={result.trackId} style={{ border: "1px solid #252b24", borderRadius: 10, padding: 10, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{result.artists.join(", ")} — {result.trackName}</strong>
                  <span style={{ color: result.best && result.best.confidence >= 70 ? "#9ca296" : "#ffd2a0", fontSize: 13 }}>
                    {result.best ? `${result.best.confidence}% · ${result.best.title} · ${result.best.channelTitle}` : "No YouTube match found"}
                  </span>
                </div>
                {result.best && <a className="textButton" href={result.best.url} target="_blank" rel="noreferrer">Open match ↗</a>}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="secondary" onClick={() => void matchAll(true)} disabled={busy}>Recheck YouTube</button>
            {!serverConfigured && <button className="textButton" onClick={() => { window.localStorage.removeItem(KEY_STORAGE); setApiKey(""); }}>Change API key</button>}
          </div>
        </details>
      )}
    </div>
  );
}
