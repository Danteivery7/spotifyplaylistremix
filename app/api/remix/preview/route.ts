import { NextRequest, NextResponse } from "next/server";
import { engineUrlForRequest } from "@/lib/server-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get("jobId");
  const transition = request.nextUrl.searchParams.get("transition");

  if (!jobId || !/^[a-f0-9]{32}$/.test(jobId)) {
    return NextResponse.json({ error: "A valid jobId is required." }, { status: 400 });
  }
  if (!transition || !/^\d+$/.test(transition)) {
    return NextResponse.json({ error: "A valid transition index is required." }, { status: 400 });
  }

  try {
    const response = await fetch(`${engineUrlForRequest(request)}/jobs/${jobId}/preview/${transition}`, { cache: "no-store" });
    if (!response.ok) {
      const text = await response.text();
      return new NextResponse(text, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      });
    }

    const headers = new Headers();
    headers.set("content-type", response.headers.get("content-type") ?? "audio/mp4");
    headers.set("content-disposition", response.headers.get("content-disposition") ?? `inline; filename="transition-${transition}.m4a"`);
    headers.set("cache-control", "private, no-store");
    return new Response(response.body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "Audio engine is offline." }, { status: 503 });
  }
}
