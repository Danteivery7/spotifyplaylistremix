import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { extractSpotifyPlaylistId } from "@/lib/spotify";
import type { PlaylistPayload, PlaylistTrack } from "@/lib/types";

export const runtime = "nodejs";

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
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (response.status === 401) throw new Error("AUTH");
  if (response.status === 403) throw new Error("FORBIDDEN");
  if (!response.ok) throw new Error(`Spotify returned ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { playlistUrl?: string };
  const playlistId = body.playlistUrl ? extractSpotifyPlaylistId(body.playlistUrl) : null;
  if (!playlistId) return NextResponse.json({ error: "Paste a valid Spotify playlist link." }, { status: 400 });

  const cookieStore = await cookies();
  const token = cookieStore.get("spr_access_token")?.value;
  if (!token) return NextResponse.json({ error: "Spotify is not connected." }, { status: 401 });

  try {
    const meta = await spotifyFetch<{
      id: string;
      name: string;
      description?: string;
      images?: SpotifyImage[];
      external_urls?: { spotify?: string };
      items?: { total: number };
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
          spotifyUrl: item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`
        });
      }
      nextUrl = page.next;
    }

    const payload: PlaylistPayload = {
      id: meta.id,
      name: meta.name,
      description: meta.description ?? "",
      imageUrl: meta.images?.[0]?.url ?? null,
      spotifyUrl: meta.external_urls?.spotify ?? body.playlistUrl!,
      tracks
    };
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH") return NextResponse.json({ error: "Spotify session expired. Reconnect Spotify." }, { status: 401 });
    if (error instanceof Error && error.message === "FORBIDDEN") return NextResponse.json({ error: "Spotify currently exposes playlist items only for playlists you own or collaborate on in development mode." }, { status: 403 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Spotify request failed." }, { status: 502 });
  }
}
