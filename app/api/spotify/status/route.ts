import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { connected: false, configured: true, mode: "browser_pkce" },
    { headers: { "cache-control": "no-store" } },
  );
}
