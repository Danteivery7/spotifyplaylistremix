"use client";

import { useEffect, useMemo, useState } from "react";
import type { PlaylistPayload } from "@/lib/types";
import { getPersonalEngineUrl, savePersonalEngineUrl } from "@/lib/personal-engine";

type MatchRow = {
  spotify_id: string;
  title: string;
  artists: string[];
  filename: string;
  provider?: string;
  score: number;
};

type ResolveResult = {
  ready: boolean;
  total: number;
  matched: number;
  missing: string[];
  matches: MatchRow[];
  automatic_providers?: string[];
};

type Props = {
  playlist: PlaylistPayload;
  onReadyChange?: (ready: boolean) => void;
};

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"];

async function readEngineJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const clean = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    if (response.status === 404) {
      throw new Error("That address does not point to the Playlist Remix engine. Copy the HTTPS trycloudflare.com URL printed by the personal-engine launcher.");
    }
    if (/cloudflare|worker|error code|bad gateway|gateway timeout/i.test(clean)) {
      throw new Error("The remix engine is not reachable at that address. Restart the personal engine/tunnel, then save its new HTTPS URL here.");
    }
    throw new Error(clean ? `The remix engine returned: ${clean}` : `The remix engine did not return a usable response (${response.status}).`);
  }
}

function normalizeEngineUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function providerLabel(value?: string) {
  switch ((value ?? "library").toLowerCase()) {
    case "soundcloud": return "SoundCloud";
    case "audius": return "Audius";
    case "jamendo": return "Jamendo";
    case "upload": return "Uploaded";
    default: return "Library/cache";
  }
}

export default function AudioEngineStage({ playlist, onReadyChange }: Props) {
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [engineUrl, setEngineUrl] = useState("");
  const [engineConnected, setEngineConnected] = useState(false);
  const [showEngineSetup, setShowEngineSetup] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);

  const fingerprint = useMemo(
    () => `${playlist.id}:${playlist.tracks.map((track) => track.id).join("|")}`,
    [playlist],
  );

  async function checkSources(baseOverride?: string) {
    const base = normalizeEngineUrl(baseOverride ?? getPersonalEngineUrl());
    onReadyChange?.(false);
    setResult(null);
    setError(null);

    if (!base) {
      setEngineConnected(false);
      setProviders([]);
      setShowEngineSetup(true);
      setProgress("Connect the personal remix engine to analyze and render audio.");
      return;
    }

    setChecking(true);
    try {
      const healthResponse = await fetch(`${base}/health`, { cache: "no-store" });
      const health = await readEngineJson(healthResponse);
      if (!healthResponse.ok || health.status !== "ok") {
        throw new Error(String(health.error ?? health.detail ?? "The personal remix engine did not pass its health check."));
      }

      const configuredProviders = Array.isArray(health.automatic_providers)
        ? health.automatic_providers.filter((value): value is string => typeof value === "string")
        : [];
      setProviders(configuredProviders);
      setEngineConnected(true);

      const response = await fetch(`${base}/media/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(playlist),
        cache: "no-store",
      });
      const body = await readEngineJson(response);
      if (!response.ok) {
        throw new Error(String(body.error ?? body.detail ?? "Could not check the audio library."));
      }

      const next = body as unknown as ResolveResult;
      setResult(next);
      if (Array.isArray(next.automatic_providers)) setProviders(next.automatic_providers);
      onReadyChange?.(next.ready);
      setShowEngineSetup(false);
      setProgress(next.ready ? "Every included song is matched to remixable audio." : `${next.matched}/${next.total} songs matched after automatic provider lookup.`);
    } catch (err) {
      setEngineConnected(false);
      setProviders([]);
      setShowEngineSetup(true);
      setError(err instanceof Error ? err.message : "Could not reach the personal remix engine.");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    const saved = getPersonalEngineUrl();
    setEngineUrl(saved);
    setProgress("");
    void checkSources(saved);
    // fingerprint intentionally changes whenever the selected mix changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  function saveEngine() {
    const clean = normalizeEngineUrl(engineUrl);
    if (clean && !/^https?:\/\//i.test(clean)) {
      setError("Paste the complete engine URL beginning with https://");
      return;
    }
    const saved = savePersonalEngineUrl(clean);
    setEngineUrl(saved);
    setProgress(saved ? "Engine saved. Testing the connection…" : "Personal engine cleared.");
    void checkSources(saved);
  }

  function clearEngine() {
    savePersonalEngineUrl("");
    setEngineUrl("");
    setEngineConnected(false);
    setProviders([]);
    setResult(null);
    onReadyChange?.(false);
    setShowEngineSetup(true);
    setError(null);
    setProgress("Personal engine cleared.");
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const base = normalizeEngineUrl(getPersonalEngineUrl());
    if (!base) {
      setShowEngineSetup(true);
      setError("Connect the personal remix engine before adding audio.");
      return;
    }

    const selected = Array.from(files).filter((file) =>
      AUDIO_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension)),
    );
    if (!selected.length) {
      setError("Choose MP3, WAV, FLAC, M4A, AAC, OGG, or OPUS audio files.");
      return;
    }

    setUploading(true);
    setError(null);
    onReadyChange?.(false);
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const file = selected[index];
        setProgress(`Adding ${index + 1}/${selected.length} · ${file.name}`);
        const data = new FormData();
        data.append("file", file, file.name);
        const response = await fetch(`${base}/media/upload`, { method: "POST", body: data });
        const body = await readEngineJson(response);
        if (!response.ok) {
          throw new Error(`${file.name}: ${String(body.error ?? body.detail ?? "upload failed")}`);
        }
      }
      setProgress(`${selected.length} file${selected.length === 1 ? "" : "s"} added. Re-matching the playlist…`);
      await checkSources(base);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Audio upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function chooseFolder() {
    if (uploading) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus";
    input.setAttribute("webkitdirectory", "");
    input.addEventListener("change", () => void uploadFiles(input.files));
    input.click();
  }

  const missing = result?.missing ?? [];
  const matches = result?.matches ?? [];

  return (
    <div id="audio-source-stage" style={{ margin: "18px 22px 0", border: "1px solid #30362e", borderRadius: 16, padding: 18, background: "rgba(10,13,10,.72)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ maxWidth: 760 }}>
          <strong style={{ display: "block", fontSize: 18, marginBottom: 4 }}>Remixable audio sources</strong>
          <span style={{ color: "#9ca296", lineHeight: 1.55 }}>
            The engine checks its cache/library and automatically searches every configured provider that can explicitly supply a downloadable track. Manual files are only the fallback for songs the automatic providers cannot supply.
          </span>
          {engineConnected && (
            <div style={{ marginTop: 8, color: providers.length ? "#b8f7cd" : "#9ca296", fontSize: 13 }}>
              {providers.length ? `Automatic providers active: ${providers.map(providerLabel).join(" · ")}` : "No automatic downloadable providers are configured on this engine yet."}
            </div>
          )}
        </div>
        <div className="successBadge" style={{ opacity: engineConnected ? 1 : .7 }}>
          {checking ? "Searching sources…" : engineConnected ? result ? `${result.matched}/${result.total} matched` : "Engine connected" : "Engine not connected"}
        </div>
      </div>

      {(showEngineSetup || !engineConnected) && (
        <div style={{ marginTop: 16, border: "1px solid #3b4439", borderRadius: 12, padding: 14, background: "#090b09" }}>
          <strong style={{ display: "block", marginBottom: 5 }}>Connect the personal remix engine</strong>
          <div style={{ color: "#9ca296", fontSize: 13, lineHeight: 1.55, marginBottom: 10 }}>
            Run <b>START_PERSONAL_REMIX_HIGH_QUALITY.cmd</b> on your PC, copy the HTTPS <b>trycloudflare.com</b> address it prints, and paste it here. Run <b>SETUP_MEDIA_PROVIDERS.cmd</b> once to enable any SoundCloud, Audius or Jamendo credentials you have.
          </div>
          <div className="inputRow">
            <input className="urlInput" value={engineUrl} onChange={(event) => setEngineUrl(event.target.value)} placeholder="https://...trycloudflare.com" aria-label="Personal remix engine URL" />
            <button className="primary" onClick={saveEngine}>Save & Test</button>
            {engineUrl && <button className="secondary" onClick={clearEngine}>Clear</button>}
          </div>
        </div>
      )}

      {engineConnected && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 16 }}>
          <button className="primary" onClick={() => void checkSources()} disabled={checking || uploading}>{checking ? "Searching…" : "Search All Sources"}</button>
          <label className="secondary" style={{ display: "inline-flex", alignItems: "center", cursor: uploading ? "default" : "pointer" }}>
            {uploading ? "Adding…" : "Add Audio Files"}
            <input type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus" multiple disabled={uploading} onChange={(event) => { void uploadFiles(event.target.files); event.currentTarget.value = ""; }} style={{ display: "none" }} />
          </label>
          <button className="secondary" onClick={chooseFolder} disabled={uploading}>Add Folder</button>
          <button className="textButton" onClick={() => setShowEngineSetup((value) => !value)}>Engine Settings</button>
          {result?.ready && <span style={{ color: "#b8f7cd", fontWeight: 700 }}>✓ Ready to mix</span>}
        </div>
      )}

      {progress && <div style={{ marginTop: 12, color: engineConnected ? "#b8f7cd" : "#ffd2a0", fontSize: 14 }}>{progress}</div>}
      {error && <div className="error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      {missing.length > 0 && (
        <div style={{ marginTop: 16, border: "1px solid rgba(255,177,92,.35)", background: "rgba(255,177,92,.07)", borderRadius: 12, padding: 14 }}>
          <strong style={{ color: "#fff0de" }}>{missing.length} selected song{missing.length === 1 ? "" : "s"} still need audio after automatic lookup</strong>
          <div style={{ color: "#ffd2a0", marginTop: 7, lineHeight: 1.55 }}>{missing.slice(0, 12).join(" • ")}{missing.length > 12 ? ` • +${missing.length - 12} more` : ""}</div>
        </div>
      )}

      {matches.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", color: "#c7cec2" }}>See {matches.length} remixable audio matches</summary>
          <div style={{ marginTop: 10, display: "grid", gap: 7 }}>
            {matches.slice(0, 30).map((match) => (
              <div key={`${match.spotify_id}-${match.filename}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "#9ca296", fontSize: 13 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{match.artists.join(", ")} — {match.title}</span>
                <span style={{ flex: "0 0 auto" }}>{providerLabel(match.provider)} · {Math.round(match.score * 100)}%</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
