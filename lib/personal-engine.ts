const ENGINE_URL_KEY = "spr_personal_engine_url";

export function getPersonalEngineUrl(): string {
  if (typeof window === "undefined") return "";
  return (window.localStorage.getItem(ENGINE_URL_KEY) ?? "").trim().replace(/\/$/, "");
}

export function savePersonalEngineUrl(value: string): string {
  if (typeof window === "undefined") return "";
  const clean = value.trim().replace(/\/$/, "");
  if (clean) window.localStorage.setItem(ENGINE_URL_KEY, clean);
  else window.localStorage.removeItem(ENGINE_URL_KEY);
  return clean;
}

export function personalEngineEndpoint(enginePath: string, proxyPath: string): string {
  const base = getPersonalEngineUrl();
  return base ? `${base}${enginePath.startsWith("/") ? enginePath : `/${enginePath}`}` : proxyPath;
}

export function personalEngineDownload(jobId: string, kind: "audio" | "video"): string {
  const base = getPersonalEngineUrl();
  return base
    ? `${base}/jobs/${encodeURIComponent(jobId)}/download/${kind}`
    : `/api/remix/download?jobId=${encodeURIComponent(jobId)}&kind=${kind}`;
}
