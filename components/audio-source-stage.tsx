"use client";

import { useEffect, useMemo, useState } from "react";
import type { PlaylistPayload } from "@/lib/types";
import {
  getPersonalEngineUrl,
  personalEngineEndpoint,
  savePersonalEngineUrl,
} from "@/lib/personal-engine";

type MatchRow = {
  spotify_id: string;
  title: string;
  artists: string[];
  filename: string;
  score: number;
};

type ResolveResult = {
  ready: boolean;
  total: number;
  matched: number;
  missing: string[];
  matches: MatchRow[];
};

type Props = {
  playlist: PlaylistPayload;
  onReadyChange?: (ready: boolean) => void;
};

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"];

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`The audio service returned an unreadable response (${response.status}).`);
  }
}

export default function AudioSourceStage({ playlist, onReadyChange }: Props) {
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [engineUrl, setEngineUrl] = useState("");
  const [showEngineSetup, setShowEngineSetup] = useState(false);

  const fingerprint = useMemo(
    () => `${playlist.id}:${playlist.tracks.map((track) => track.id).join("|")}`,
    [playlist],
  );

  useEffect(() => {
    setEngineUrl(getPersonalEngineUrl());
  }, []);

  async function checkSources() {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch(
        personalEngineEndpoint("/media/resolve", "/api/remix/media/resolve"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(playlist),
          cache: "no-store",
        },
      );
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(String(body.error ?? body.detail ?? "Could not check the audio library."));
      }
      const next = body as unknown as ResolveResult;
      setResult(next);
      onReadyChange?.(next.ready);
      setShowEngineSetup(false);
    } catch (err) {
      setResult(null);
      onReadyChange?.(false);
      setShowEngineSetup(true);
      setError(err instanceof Error ? err.message : "Could not check the audio library.");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    onReadyChange?.(false);
    setResult(null);
    setProgress("");
    void checkSources();
    // The fingerprint intentionally represents the selected mix, including exclusions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  function saveEngine() {
    const saved = savePersonalEngineUrl(engineUrl);
    setEngineUrl(saved);
    setProgress(saved ? "Personal engine URL saved. Checking connection…" : "Using the Cloudflare-configured engine.");
    void checkSources();
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
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
        setProgress(`Uploading ${index + 1}/${selected.length} · ${file.name}`);
        const data = new FormData();
        data.append("file", file, file.name);
        const response = await fetch(
          personalEngineEndpoint("/media/upload", "/api/remix/media/upload"),
          { method: "POST", body: data },
        );
        const body = await readJson(response);
        if (!response.ok) {
          throw new Error(`${file.name}: ${String(body.error ?? body.detail ?? "upload failed")}`);
        }
      }
      setProgress(`${selected.length} audio file${selected.length === 1 ? "" : "s"} uploaded. Matching them to the playlist…`);
      await checkSources();
      setProgress("Audio library updated.");
    } catch (err) {
      setShowEngineSetup(true);
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
        <div>
          <strong style={{ display: "block", fontSize: 18, marginBottom: 4 }}>Audio sources</strong>
          <span style={{ color: "#9ca296", lineHeight: 1.5 }}>The personal engine scans your Windows Music folder automatically. You can also add individual files or a whole folder, and it matches them by tags, title, artist, filename, and duration.</span>
        </div>
        <div className="successBadge" style={{ opacity: result?.ready ? 1 : .75 }}>
          {checking ? "Checking…" : result ? `${result.matched}/${result.total} matched` : "Engine check"}
        </div>
      </div>

      {(showEngineSetup || engineUrl) && (
        <div style={{ marginTop: 16, border: "1px solid #30362e", borderRadius: 12, padding: 14, background: "#090b09" }}>
          <strong style={{ display: "block", marginBottom: 5 }}>Personal remix engine</strong>
          <div style={{ color: "#9ca296", fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>If the Cloudflare-hosted site cannot reach the engine, run the personal engine on your PC and paste its HTTPS Cloudflare Tunnel URL here. This stays only in this browser.</div>
          <div className="inputRow">
            <input className="urlInput" value={engineUrl} onChange={(event) => setEngineUrl(event.target.value)} placeholder="https://your-engine.trycloudflare.com" aria-label="Personal remix engine URL" />
            <button className="secondary" onClick={saveEngine}>Save Engine</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 16 }}>
        <label className="primary" style={{ display: "inline-flex", alignItems: "center", cursor: uploading ? "default" : "pointer" }}>
          {uploading ? "Uploading…" : "Add Audio Files"}
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus"
            multiple
            disabled={uploading}
            onChange={(event) => {
              void uploadFiles(event.target.files);
              event.currentTarget.value = "";
            }}
            style={{ display: "none" }}
          />
        </label>
        <button className="secondary" onClick={chooseFolder} disabled={uploading}>Add Folder</button>
        <button className="secondary" onClick={() => void checkSources()} disabled={checking || uploading}>Check Again</button>
        {!showEngineSetup && <button className="textButton" onClick={() => setShowEngineSetup(true)}>Engine Settings</button>}
        {result?.ready && <span style={{ color: "#b8f7cd", fontWeight: 700 }}>✓ Every included song has audio</span>}
      </div>

      {progress && <div style={{ marginTop: 12, color: "#b8f7cd", fontSize: 14 }}>{progress}</div>}
      {error && <div className="error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      {missing.length > 0 && (
        <div style={{ marginTop: 16, border: "1px solid rgba(255,177,92,.35)", background: "rgba(255,177,92,.07)", borderRadius: 12, padding: 14 }}>
          <strong style={{ color: "#fff0de" }}>{missing.length} selected song{missing.length === 1 ? "" : "s"} still need audio</strong>
          <div style={{ color: "#ffd2a0", marginTop: 7, lineHeight: 1.55 }}>{missing.slice(0, 12).join(" • ")}{missing.length > 12 ? ` • +${missing.length - 12} more` : ""}</div>
          <div style={{ color: "#9ca296", marginTop: 8, fontSize: 13 }}>Add the missing files or X those songs out of this mix above.</div>
        </div>
      )}

      {matches.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", color: "#c7cec2" }}>See {matches.length} matched files</summary>
          <div style={{ marginTop: 10, display: "grid", gap: 7 }}>
            {matches.slice(0, 30).map((match) => (
              <div key={`${match.spotify_id}-${match.filename}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "#9ca296", fontSize: 13 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{match.artists.join(", ")} — {match.title}</span>
                <span style={{ flex: "0 0 auto" }}>{Math.round(match.score * 100)}% · {match.filename}</span>
              </div>
            ))}
            {matches.length > 30 && <div style={{ color: "#737a70", fontSize: 13 }}>+{matches.length - 30} more matched files</div>}
          </div>
        </details>
      )}
    </div>
  );
}
