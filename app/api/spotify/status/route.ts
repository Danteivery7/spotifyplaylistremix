import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const connected = Boolean(cookieStore.get("spr_access_token")?.value);
  const configured = Boolean(
    process.env.SPOTIFY_CLIENT_ID &&
    process.env.SPOTIFY_CLIENT_SECRET &&
    process.env.SPOTIFY_REDIRECT_URI,
  );

  return NextResponse.json(
    { connected, configured, publicPlaylists: true },
    { headers: { "cache-control": "no-store" } },
  );
}