import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function engineUrl() {
  return (process.env.AUDIO_ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, "");
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const response = await fetch(`${engineUrl()}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store"
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
    });
  } catch {
    return NextResponse.json({ error: "Audio engine is offline. Start the FastAPI engine first." }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId || !/^[a-f0-9]{32}$/.test(jobId)) {
    return NextResponse.json({ error: "A valid jobId is required." }, { status: 400 });
  }
  try {
    const response = await fetch(`${engineUrl()}/jobs/${jobId}`, { cache: "no-store" });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
    });
  } catch {
    return NextResponse.json({ error: "Audio engine is offline." }, { status: 503 });
  }
}
