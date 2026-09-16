import { NextRequest, NextResponse } from "next/server";
import { extractYouTubePlaylistId, parseIsoDuration, youtubeApiKey, youtubeFetch, type YouTubeVideoRecord } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PlaylistItemsResponse = {
  nextPageToken?: string;
  items?: Array<{
    contentDetails?: { videoId?: string };
    snippet?: { resourceId?: { videoId?: string }; title?: string; position?: number };
  }>;
};

type PlaylistResponse = {
  items?: Array<{ snippet?: { title?: string; description?: string; thumbnails?: Record<string, { url?: string }> } }>;
};

type VideosResponse = {
  items?: Array<{
    id: string;
    snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> };
    contentDetails?: { duration?: string };
    status?: { embeddable?: boolean };
  }>;
};

function thumbnail(thumbnails?: Record<string, { url?: string }>) {
  if (!thumbnails) return null;
  return thumbnails.maxres?.url ?? thumbnails.standard?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null;
}

export async function POST(request: NextRequest) {
  const apiKey = youtubeApiKey(request.headers.get("x-youtube-api-key"));
  if (!apiKey) {
    return NextResponse.json({ error: "YouTube API key is required.", code: "YOUTUBE_KEY_REQUIRED" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({})) as { url?: string };
  const playlistId = extractYouTubePlaylistId(body.url ?? "");
  if (!playlistId) return NextResponse.json({ error: "Paste a valid YouTube playlist link." }, { status: 400 });

  try {
    const meta = await youtubeFetch<PlaylistResponse>("playlists", apiKey, { part: "snippet", id: playlistId });
    const playlistMeta = meta.items?.[0];
    if (!playlistMeta) return NextResponse.json({ error: "That YouTube playlist could not be found or is not public." }, { status: 404 });

    const orderedIds: string[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    do {
      if (++pageCount > 400) throw new Error("YouTube playlist pagination exceeded a safe limit.");
      const page = await youtubeFetch<PlaylistItemsResponse>("playlistItems", apiKey, {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of page.items ?? []) {
        const id = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        if (id) orderedIds.push(id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const details = new Map<string, YouTubeVideoRecord>();
    for (let index = 0; index < orderedIds.length; index += 50) {
      const ids = orderedIds.slice(index, index + 50);
      const videos = await youtubeFetch<VideosResponse>("videos", apiKey, {
        part: "snippet,contentDetails,status",
        id: ids.join(","),
        maxResults: "50",
      });
      for (const item of videos.items ?? []) {
        details.set(item.id, {
          id: item.id,
          title: item.snippet?.title ?? "YouTube video",
          channelTitle: item.snippet?.channelTitle ?? "",
          durationSeconds: parseIsoDuration(item.contentDetails?.duration),
          thumbnailUrl: thumbnail(item.snippet?.thumbnails),
          url: `https://www.youtube.com/watch?v=${item.id}`,
          embeddable: item.status?.embeddable !== false,
        });
      }
    }

    const videos = orderedIds.map((id) => details.get(id)).filter((value): value is YouTubeVideoRecord => Boolean(value));
    return NextResponse.json({
      id: playlistId,
      name: playlistMeta.snippet?.title ?? "YouTube Playlist",
      description: playlistMeta.snippet?.description ?? "",
      imageUrl: thumbnail(playlistMeta.snippet?.thumbnails),
      url: `https://www.youtube.com/playlist?list=${playlistId}`,
      videos,
      missingCount: orderedIds.length - videos.length,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "YouTube playlist request failed." }, { status: 502 });
  }
}
