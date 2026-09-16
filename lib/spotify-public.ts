import type { PlaylistPayload, PlaylistTrack } from "@/lib/types";

type JsonObject = Record<string, unknown>;

type SpotifyOEmbed = {
  title?: string;
  thumbnail_url?: string;
};

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findArrayByName(value: unknown, name: string): unknown[] | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArrayByName(item, name);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (key === name && Array.isArray(child)) return child;
    const found = findArrayByName(child, name);
    if (found) return found;
  }
  return null;
}

function findPlaylistName(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlaylistName(item);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if (value.type === "playlist" && typeof value.name === "string" && value.name.trim()) {
    return value.name.trim();
  }
  for (const child of Object.values(value)) {
    const found = findPlaylistName(child);
    if (found) return found;
  }
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function durationMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value > 10_000 ? value : value * 1000);
  }
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Math.round(parsed > 10_000 ? parsed : parsed * 1000);
  }
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    const [minutes, seconds] = trimmed.split(":").map(Number);
    return (minutes * 60 + seconds) * 1000;
  }
  return 0;
}

function trackIdFromUri(uri: string): string | null {
  const match = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  return match?.[1] ?? null;
}

function splitArtists(subtitle: string): string[] {
  return subtitle
    .split(/,|\s+•\s+/)
    .map((artist) => artist.trim())
    .filter(Boolean);
}

export function parseSpotifyEmbedHtml(
  html: string,
  playlistId: string,
  playlistUrl: string,
  metadata?: SpotifyOEmbed,
): PlaylistPayload {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("Spotify's public playlist page did not include readable playlist data.");

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error("Spotify returned playlist data in an unreadable format.");
  }

  const rawTracks = findArrayByName(data, "trackList");
  if (!rawTracks?.length) throw new Error("No songs were found in that public Spotify playlist.");

  const tracks: PlaylistTrack[] = [];
  for (const [index, raw] of rawTracks.entries()) {
    if (!isObject(raw)) continue;
    const name = text(raw.title) || text(raw.name);
    if (!name) continue;
    const subtitle = text(raw.subtitle);
    const uri = text(raw.uri);
    const id = trackIdFromUri(uri) ?? `public-${playlistId}-${index}`;
    tracks.push({
      id,
      name,
      artists: splitArtists(subtitle),
      album: text(raw.album) || text(raw.albumName),
      durationMs: durationMs(raw.durationMs ?? raw.duration_ms ?? raw.duration),
      imageUrl: null,
      spotifyUrl: id.startsWith("public-") ? playlistUrl : `https://open.spotify.com/track/${id}`,
    });
  }

  if (!tracks.length) throw new Error("Spotify returned the playlist, but none of its rows could be read as songs.");

  return {
    id: playlistId,
    name: findPlaylistName(data) ?? metadata?.title?.trim() ?? "Spotify Playlist",
    description: "",
    imageUrl: metadata?.thumbnail_url ?? null,
    spotifyUrl: playlistUrl,
    tracks,
    source: "public_embed",
    truncated: rawTracks.length >= 100,
  };
}

export async function fetchPublicSpotifyPlaylist(playlistId: string, playlistUrl: string): Promise<PlaylistPayload> {
  const canonicalUrl = `https://open.spotify.com/playlist/${playlistId}`;
  const [embedResponse, oEmbedResponse] = await Promise.all([
    fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": DESKTOP_USER_AGENT,
      },
      cache: "no-store",
    }),
    fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(canonicalUrl)}`, {
      headers: { accept: "application/json", "user-agent": DESKTOP_USER_AGENT },
      cache: "no-store",
    }).catch(() => null),
  ]);

  if (!embedResponse.ok) {
    throw new Error(`Spotify's public playlist page returned ${embedResponse.status}.`);
  }

  const html = await embedResponse.text();
  let metadata: SpotifyOEmbed | undefined;
  if (oEmbedResponse?.ok) {
    metadata = (await oEmbedResponse.json().catch(() => undefined)) as SpotifyOEmbed | undefined;
  }
  return parseSpotifyEmbedHtml(html, playlistId, playlistUrl, metadata);
}
