import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { extractSpotifyPlaylistId } from "@/lib/spotify";
import { fetchPublicSpotifyPlaylist } from "@/lib/spotify-public";
import type { PlaylistPayload, PlaylistTrack } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SpotifyImage = { url: string };
type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms: number;
  external_urls?: { spotify?: string };
  artists?: Array<{ name: string }>;
  album?: { name?: string; images?: SpotifyImage[] };
  type?: string;
};
type SpotifyPlaylistItem = { item?: SpotifyTrack | null };

async function spotifyFetch<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("AUTH");
  if (response.status === 403) throw new Error("FORBIDDEN");
  if (!response.ok) throw new Error(`Spotify returned ${response.status}.`);
  return response.json() as Promise<T>;
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
  let nextUrl: string | null = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50`;
  while (nextUrl) {
    const page: { items: SpotifyPlaylistItem[]; next: string | null } = await spotifyFetch(nextUrl, token);
    for (const row of page.items ?? []) {
      const item = row.item;
      if (!item || item.type !== "track") continue;
      tracks.push({
        id: item.id,
        name: item.name,
        artists: item.artists?.map((artist) => artist.name) ?? [],
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

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { playlistUrl?: string };
  const playlistUrl = body.playlistUrl?.trim() ?? "";
  const playlistId = playlistUrl ? extractSpotifyPlaylistId(playlistUrl) : null;
  if (!playlistId) {
    return NextResponse.json({ error: "Paste a valid Spotify playlist link." }, { status: 400 });
  }

  let publicPlaylist: PlaylistPayload | null = null;
  let publicError: string | null = null;

  try {
    publicPlaylist = await fetchPublicSpotifyPlaylist(playlistId, playlistUrl);
    if (!publicPlaylist.truncated) {
      return NextResponse.json(publicPlaylist, { headers: { "cache-control": "no-store" } });
    }
  } catch (error) {
    publicError = error instanceof Error ? error.message : "The public playlist could not be read.";
  }

  const cookieStore = await cookies();
  const token = cookieStore.get("spr_access_token")?.value;

  if (token) {
    try {
      const apiPlaylist = await fetchWithSpotifyApi(playlistId, playlistUrl, token);
      return NextResponse.json(apiPlaylist, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (publicPlaylist) {
        return NextResponse.json(publicPlaylist, { headers: { "cache-control": "no-store" } });
      }
      if (error instanceof Error && error.message === "AUTH") {
        return NextResponse.json({ error: "Your optional Spotify connection expired. Public playlists still work without signing in." }, { status: 401 });
      }
    }
  }

  if (publicPlaylist) {
    return NextResponse.json(publicPlaylist, { headers: { "cache-control": "no-store" } });
  }

  const oauthConfigured = Boolean(
    process.env.SPOTIFY_CLIENT_ID &&
    process.env.SPOTIFY_CLIENT_SECRET &&
    process.env.SPOTIFY_REDIRECT_URI,
  );

  return NextResponse.json(
    {
      error: oauthConfigured
        ? "That playlist could not be read publicly. If it is private, use the optional Connect Spotify button and try again."
        : "That playlist could not be read as a public Spotify playlist. Make sure the playlist is public and paste its normal Spotify share link.",
      detail: publicError,
    },
    { status: 422 },
  );
}