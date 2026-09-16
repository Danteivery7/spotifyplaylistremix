import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function engineUrl() {
  return (process.env.AUDIO_ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, "");
}

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  const kind = request.nextUrl.searchParams.get("kind");

  if (!jobId || !/^[a-f0-9]{32}$/.test(jobId)) {
    return NextResponse.json({ error: "A valid jobId is required." }, { status: 400 });
  }
  if (kind !== "audio" && kind !== "video") {
    return NextResponse.json({ error: "kind must be audio or video." }, { status: 400 });
  }

  try {
    const response = await fetch(`${engineUrl()}/jobs/${jobId}/download/${kind}`, { cache: "no-store" });
    if (!response.ok) {
      const text = await response.text();
      return new NextResponse(text, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
      });
    }

    const headers = new Headers();
    headers.set("content-type", response.headers.get("content-type") ?? "application/octet-stream");
    headers.set("content-disposition", response.headers.get("content-disposition") ?? `attachment; filename="remix.${kind === "audio" ? "m4a" : "mp4"}"`);
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);
    headers.set("cache-control", "private, no-store");

    return new Response(response.body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "Audio engine is offline." }, { status: 503 });
  }
}
