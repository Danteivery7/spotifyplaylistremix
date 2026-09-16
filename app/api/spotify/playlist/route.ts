import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { extractSpotifyPlaylistId } from "@/lib/spotify";
import { fetchPublicSpotifyPlaylist } from "@/lib/spotify-public";
import type { PlaylistPayload, PlaylistTrack } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SpotifyImage = { url: string };
type SpotifyArtist = { name: string };
type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms: number;
  external_urls?: { spotify?: string };
  artists?: SpotifyArtist[];
  album?: { name?: string; images?: SpotifyImage[] };
  type?: string;
};
type SpotifyPlaylistItem = { item?: SpotifyTrack | null };
type SpotifyPlaylistPage = {
  items: SpotifyPlaylistItem[];
  next: string | null;
};

async function spotifyFetch<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
  });
  const text = await response.text();
  if (response.status === 401) throw new Error("AUTH");
  if (response.status === 403) throw new Error("FORBIDDEN");
  if (!response.ok) throw new Error(`Spotify returned ${response.status}.`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Spotify returned unreadable API data (${response.status}).`);
  }
}

async function fetchWithSpotifyApi(playlistId: string, playlistUrl: string, token: string): Promise<PlaylistPayload> {
  const meta = await spotifyFetch<{
    id: string;
    name: string;
    description?: string;
    images?: SpotifyImage[];
    external_urls?: { spotify?: string };
  }>(`https://api.spotify.com/v1/playlists/${playlistId}`, token);

  const tracks: PlaylistTrack[] = [];
  let nextUrl: string | null = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50&offset=0`;
  let pageCount = 0;
  while (nextUrl) {
    if (++pageCount > 500) throw new Error("Spotify pagination exceeded a safe limit.");
    const page: SpotifyPlaylistPage = await spotifyFetch<SpotifyPlaylistPage>(nextUrl, token);
    for (const row of page.items ?? []) {
      const item = row.item;
      if (!item || item.type !== "track") continue;
      tracks.push({
        id: item.id,
        name: item.name,
        artists: item.artists?.map((artist: SpotifyArtist) => artist.name) ?? [],
        album: item.album?.name ?? "",
        durationMs: item.duration_ms,
        imageUrl: item.album?.images?.[0]?.url ?? null,
        spotifyUrl: item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`,
      });
    }
    nextUrl = page.next;
  }

  if (!tracks.length) throw new Error("FORBIDDEN");
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description ?? "",
    imageUrl: meta.images?.[0]?.url ?? null,
    spotifyUrl: meta.external_urls?.spotify ?? playlistUrl,
    tracks,
    source: "spotify_api",
    truncated: false,
  };
}

function bearerFrom(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function POST(request: NextRequest) {
  let body: { playlistUrl?: string } = {};
  try {
    body = await request.json() as { playlistUrl?: string };
  } catch {
    return NextResponse.json({ error: "The playlist request was not valid JSON." }, { status: 400 });
  }

  const playlistUrl = body.playlistUrl?.trim() ?? "";
  const playlistId = playlistUrl ? extractSpotifyPlaylistId(playlistUrl) : null;
  if (!playlistId) {
    return NextResponse.json({ error: "Paste a valid Spotify playlist link." }, { status: 400 });
  }

  const cookieStore = await cookies();
  const token = bearerFrom(request) ?? cookieStore.get("spr_access_token")?.value ?? null;
  let apiFailure: "AUTH" | "FORBIDDEN" | null = null;

  if (token) {
    try {
      const fullPlaylist = await fetchWithSpotifyApi(playlistId, playlistUrl, token);
      return NextResponse.json(fullPlaylist, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof Error && error.message === "AUTH") apiFailure = "AUTH";
      else if (error instanceof Error && error.message === "FORBIDDEN") apiFailure = "FORBIDDEN";
      else {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Spotify API request failed." },
          { status: 502 },
        );
      }
    }
  }

  try {
    const publicPlaylist = await fetchPublicSpotifyPlaylist(playlistId, playlistUrl);
    return NextResponse.json(publicPlaylist, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (apiFailure === "AUTH") {
      return NextResponse.json(
        { error: "Spotify sign-in expired. Reconnect Spotify and load the playlist again.", code: "AUTH_EXPIRED" },
        { status: 401 },
      );
    }
    if (apiFailure === "FORBIDDEN") {
      return NextResponse.json(
        {
          error: "Spotify did not allow full access to this playlist from the connected account. Sign in with the account that owns or collaborates on this playlist.",
          code: "PLAYLIST_NOT_OWNED",
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      {
        error: "Spotify's public preview could not be reached from the site. Connect Spotify to load the playlist through Spotify's official API.",
        code: "PUBLIC_IMPORT_FAILED",
        detail: error instanceof Error ? error.message : "Public Spotify import failed.",
      },
      { status: 502 },
    );
  }
}
