import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeVideoId, parseIsoDuration, youtubeApiKey, youtubeFetch, type YouTubeVideoRecord } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VideoListResponse = {
  items?: Array<{
    id: string;
    snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> };
    contentDetails?: { duration?: string };
    status?: { embeddable?: boolean };
  }>;
};

export async function POST(request: NextRequest) {
  const apiKey = youtubeApiKey(request.headers.get("x-youtube-api-key"));
  if (!apiKey) {
    return NextResponse.json({ error: "YouTube API key is required.", code: "YOUTUBE_KEY_REQUIRED" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({})) as { url?: string };
  const id = extractYouTubeVideoId(body.url ?? "");
  if (!id) return NextResponse.json({ error: "Paste a valid YouTube video link." }, { status: 400 });

  try {
    const data = await youtubeFetch<VideoListResponse>("videos", apiKey, {
      part: "snippet,contentDetails,status",
      id,
    });
    const item = data.items?.[0];
    if (!item) return NextResponse.json({ error: "That YouTube video could not be found." }, { status: 404 });
    const thumbs = item.snippet?.thumbnails ?? {};
    const thumbnailUrl = thumbs.maxres?.url ?? thumbs.standard?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null;
    const video: YouTubeVideoRecord = {
      id: item.id,
      title: item.snippet?.title ?? "YouTube video",
      channelTitle: item.snippet?.channelTitle ?? "",
      durationSeconds: parseIsoDuration(item.contentDetails?.duration),
      thumbnailUrl,
      url: `https://www.youtube.com/watch?v=${item.id}`,
      embeddable: item.status?.embeddable !== false,
    };
    return NextResponse.json(video, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "YouTube request failed." }, { status: 502 });
  }
}
