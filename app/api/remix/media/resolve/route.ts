import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function engineUrl() {
  return (process.env.AUDIO_ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, "");
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const response = await fetch(`${engineUrl()}/media/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json(
      { error: "Audio engine is offline. Connect the personal remix engine before checking audio sources." },
      { status: 503 },
    );
  }
}
