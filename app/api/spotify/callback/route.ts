import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("spr_state")?.value;

  if (!code || !state || state !== expectedState) {
    return NextResponse.json({ error: "Spotify authorization state did not match." }, { status: 400 });
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.json({ error: "Spotify environment variables are not configured." }, { status: 500 });
  }

  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    cache: "no-store"
  });

  if (!tokenResponse.ok) {
    return NextResponse.json({ error: "Spotify token exchange failed." }, { status: 502 });
  }

  const token = await tokenResponse.json() as { access_token: string; expires_in: number; refresh_token?: string };
  const response = NextResponse.redirect(appUrl);
  response.cookies.set("spr_access_token", token.access_token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: Math.max(60, token.expires_in - 60), path: "/" });
  if (token.refresh_token) response.cookies.set("spr_refresh_token", token.refresh_token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 30, path: "/" });
  response.cookies.delete("spr_state");
  return response;
}
