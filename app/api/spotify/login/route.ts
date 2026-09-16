import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL("/", request.url);
  url.searchParams.set("spotifySetup", "1");
  return NextResponse.redirect(url);
}
