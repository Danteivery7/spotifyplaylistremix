export type YouTubeVideoRecord = {
  id: string;
  title: string;
  channelTitle: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  url: string;
  embeddable: boolean;
};

export type YouTubeMatchCandidate = YouTubeVideoRecord & {
  score: number;
  confidence: number;
  reasons: string[];
};

export type YouTubeMatchResult = {
  trackId: string;
  trackName: string;
  artists: string[];
  explicit?: boolean;
  best: YouTubeMatchCandidate | null;
  candidates: YouTubeMatchCandidate[];
};

export function extractYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.endsWith("youtube.com")) {
      const direct = url.searchParams.get("v");
      if (direct && /^[A-Za-z0-9_-]{11}$/.test(direct)) return direct;
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
      const id = marker >= 0 ? parts[marker + 1] : null;
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
  } catch {
  }
  return null;
}

export function extractYouTubePlaylistId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{12,}$/.test(value) && !value.includes("/")) return value;
  try {
    const url = new URL(value);
    const id = url.searchParams.get("list");
    return id && /^[A-Za-z0-9_-]{12,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function parseIsoDuration(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

export async function youtubeFetch<T>(resource: string, apiKey: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("key", apiKey);
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`YouTube returned unreadable API data (${response.status}).`);
  }
  if (!response.ok) {
    const error = body.error as { message?: string } | undefined;
    throw new Error(error?.message ?? `YouTube returned ${response.status}.`);
  }
  return body as T;
}

export function youtubeApiKey(requestKey: string | null): string | null {
  return requestKey?.trim() || process.env.YOUTUBE_API_KEY?.trim() || null;
}
