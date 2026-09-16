import type { NextRequest } from "next/server";

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function savedEngineUrl(request: NextRequest): string | null {
  const raw = request.cookies.get("spr_personal_engine_url")?.value;
  if (!raw) return null;
  try {
    const parsed = new URL(decodeURIComponent(raw));
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "0.0.0.0" || isPrivateIpv4(hostname)) return null;
    return parsed.origin.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function engineUrlForRequest(request: NextRequest) {
  return savedEngineUrl(request) ?? (process.env.AUDIO_ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, "");
}
