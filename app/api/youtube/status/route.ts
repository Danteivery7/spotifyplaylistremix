import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { configured: Boolean(process.env.YOUTUBE_API_KEY?.trim()) },
    { headers: { "cache-control": "no-store" } },
  );
}
