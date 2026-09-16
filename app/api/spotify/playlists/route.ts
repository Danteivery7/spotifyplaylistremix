import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SpotifyImage = { url: string };
type SpotifyOwner = { display_name?: string | null };
type SpotifyPlaylist = {
  id: string;
  name: string;
  description?: string | null;
  images?: SpotifyImage[];
  external_urls?: { spotify?: string };
  owner?: SpotifyOwner;
  items?: { total?: number };
  tracks?: { total?: number };
};
type SpotifyPage = {
  items: SpotifyPlaylist[];
  next: string | null;
};

function bearerFrom(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function GET(request: NextRequest) {
  const token = bearerFrom(request);
  if (!token) {
    return NextResponse.json({ error: "Connect Spotify first." }, { status: 401 });
  }

  const playlists: Array<{
    id: string;
    name: string;
    description: string;
    imageUrl: string | null;
    spotifyUrl: string;
    ownerName: string;
    totalTracks: number;
  }> = [];

  let nextUrl: string | null = "https://api.spotify.com/v1/me/playlists?limit=50&offset=0";
  let pageCount = 0;

  try {
    while (nextUrl) {
      if (++pageCount > 200) throw new Error("Spotify playlist pagination exceeded a safe limit.");
      const response = await fetch(nextUrl, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        cache: "no-store",
      });
      const text = await response.text();
      if (response.status === 401) {
        return NextResponse.json({ error: "Spotify sign-in expired." }, { status: 401 });
      }
      if (!response.ok) {
        return NextResponse.json({ error: `Spotify returned ${response.status} while loading your playlists.` }, { status: response.status });
      }

      let page: SpotifyPage;
      try {
        page = JSON.parse(text) as SpotifyPage;
      } catch {
        return NextResponse.json({ error: "Spotify returned unreadable playlist data." }, { status: 502 });
      }

      for (const item of page.items ?? []) {
        playlists.push({
          id: item.id,
          name: item.name,
          description: item.description ?? "",
          imageUrl: item.images?.[0]?.url ?? null,
          spotifyUrl: item.external_urls?.spotify ?? `https://open.spotify.com/playlist/${item.id}`,
          ownerName: item.owner?.display_name ?? "Spotify",
          totalTracks: item.items?.total ?? item.tracks?.total ?? 0,
        });
      }
      nextUrl = page.next;
    }

    return NextResponse.json({ playlists }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load Spotify playlists." },
      { status: 502 },
    );
  }
}
