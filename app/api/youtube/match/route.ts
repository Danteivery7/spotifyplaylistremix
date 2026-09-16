import { NextRequest, NextResponse } from "next/server";
import type { PlaylistTrack } from "@/lib/types";
import { parseIsoDuration, youtubeApiKey, youtubeFetch, type YouTubeMatchCandidate, type YouTubeMatchResult } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchResponse = {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: { title?: string; channelTitle?: string };
  }>;
};

type VideosResponse = {
  items?: Array<{
    id: string;
    snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> };
    contentDetails?: { duration?: string };
    status?: { embeddable?: boolean };
  }>;
};

function normalize(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string) {
  return new Set(normalize(value).split(/\s+/).filter((part) => part.length > 1));
}

function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit += 1;
  return hit / a.size;
}

function thumbnail(thumbnails?: Record<string, { url?: string }>) {
  if (!thumbnails) return null;
  return thumbnails.maxres?.url ?? thumbnails.standard?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null;
}

function scoreCandidate(track: PlaylistTrack, candidate: Omit<YouTubeMatchCandidate, "score" | "confidence" | "reasons">): YouTubeMatchCandidate {
  const reasons: string[] = [];
  const titleText = normalize(candidate.title);
  const channelText = normalize(candidate.channelTitle);
  const targetTitle = tokens(track.name);
  const targetArtists = tokens(track.artists.join(" "));
  const candidateTokens = tokens(`${candidate.title} ${candidate.channelTitle}`);
  let score = 0;

  const titleMatch = overlap(targetTitle, candidateTokens);
  score += titleMatch * 38;
  if (titleMatch >= 0.8) reasons.push("strong title match");

  const artistMatch = overlap(targetArtists, candidateTokens);
  score += artistMatch * 28;
  if (artistMatch >= 0.7) reasons.push("artist match");

  const firstArtist = normalize(track.artists[0] ?? "");
  if (firstArtist && channelText.includes(firstArtist)) {
    score += 12;
    reasons.push("artist channel");
  }
  if (/\btopic\b/.test(channelText)) {
    score += 9;
    reasons.push("YouTube Topic channel");
  }
  if (/\bofficial audio\b|\baudio\b/.test(titleText)) {
    score += 8;
    reasons.push("official/audio upload");
  }
  if (/\bofficial video\b|\bmusic video\b/.test(titleText)) score += 3;

  if (track.durationMs > 0 && candidate.durationSeconds > 0) {
    const delta = Math.abs(track.durationMs / 1000 - candidate.durationSeconds);
    if (delta <= 3) { score += 22; reasons.push("duration within 3s"); }
    else if (delta <= 8) { score += 15; reasons.push("duration within 8s"); }
    else if (delta <= 15) score += 8;
    else if (delta >= 45) score -= 18;
  }

  const targetName = normalize(track.name);
  const undesirable: Array<[RegExp, string]> = [
    [/\bclean\b|\bradio edit\b|\bcensored\b/, "clean/radio edit"],
    [/\bcover\b|\bkaraoke\b|\binstrumental\b/, "cover/karaoke"],
    [/\blive\b/, "live version"],
    [/\bsped up\b|\bslowed\b|\bnightcore\b/, "speed-altered version"],
    [/\bremix\b|\bmashup\b/, "remix/mashup"],
  ];
  for (const [pattern, label] of undesirable) {
    if (pattern.test(titleText) && !pattern.test(targetName)) {
      score -= label === "clean/radio edit" && track.explicit ? 28 : 16;
      reasons.push(`penalized ${label}`);
    }
  }

  if (track.explicit) {
    if (/\bexplicit\b|\buncensored\b|\bdirty\b/.test(titleText)) {
      score += 10;
      reasons.push("explicit/original cue");
    } else if (/\bclean\b|\bradio edit\b|\bcensored\b/.test(titleText)) {
      score -= 18;
    }
  }

  if (!candidate.embeddable) score -= 8;
  const confidence = Math.max(0, Math.min(100, Math.round(score)));
  return { ...candidate, score: Math.round(score * 10) / 10, confidence, reasons };
}

async function matchTrack(track: PlaylistTrack, apiKey: string): Promise<YouTubeMatchResult> {
  const query = `${track.artists[0] ?? ""} ${track.name} ${track.explicit ? "explicit " : ""}official audio`.trim();
  const search = await youtubeFetch<SearchResponse>("search", apiKey, {
    part: "snippet",
    q: query,
    type: "video",
    maxResults: "6",
    safeSearch: "none",
    videoEmbeddable: "true",
  });
  const ids = (search.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id));
  if (!ids.length) return { trackId: track.id, trackName: track.name, artists: track.artists, explicit: track.explicit, best: null, candidates: [] };

  const details = await youtubeFetch<VideosResponse>("videos", apiKey, {
    part: "snippet,contentDetails,status",
    id: ids.join(","),
  });
  const candidates = (details.items ?? []).map((item) => scoreCandidate(track, {
    id: item.id,
    title: item.snippet?.title ?? "YouTube video",
    channelTitle: item.snippet?.channelTitle ?? "",
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    thumbnailUrl: thumbnail(item.snippet?.thumbnails),
    url: `https://www.youtube.com/watch?v=${item.id}`,
    embeddable: item.status?.embeddable !== false,
  })).sort((a, b) => b.score - a.score);

  return {
    trackId: track.id,
    trackName: track.name,
    artists: track.artists,
    explicit: track.explicit,
    best: candidates[0] ?? null,
    candidates,
  };
}

export async function POST(request: NextRequest) {
  const apiKey = youtubeApiKey(request.headers.get("x-youtube-api-key"));
  if (!apiKey) {
    return NextResponse.json({ error: "YouTube API key is required.", code: "YOUTUBE_KEY_REQUIRED" }, { status: 503 });
  }
  const body = await request.json().catch(() => ({})) as { tracks?: PlaylistTrack[] };
  const tracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 10) : [];
  if (!tracks.length) return NextResponse.json({ error: "Send at least one track to match." }, { status: 400 });

  try {
    const results: YouTubeMatchResult[] = [];
    for (const track of tracks) results.push(await matchTrack(track, apiKey));
    return NextResponse.json({ results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "YouTube matching failed." }, { status: 502 });
  }
}
