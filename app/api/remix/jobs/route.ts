import { NextRequest, NextResponse } from "next/server";
import { engineUrlForRequest } from "@/lib/server-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const response = await fetch(`${engineUrlForRequest(request)}/jobs`, {
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
    return NextResponse.json({ error: "Audio engine is offline. Start or reconnect the personal remix engine first." }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId || !/^[a-f0-9]{32}$/.test(jobId)) {
    return NextResponse.json({ error: "A valid jobId is required." }, { status: 400 });
  }
  try {
    const response = await fetch(`${engineUrlForRequest(request)}/jobs/${jobId}`, { cache: "no-store" });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "Audio engine is offline." }, { status: 503 });
  }
}
