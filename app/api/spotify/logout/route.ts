import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin);
  response.cookies.delete("spr_access_token");
  response.cookies.delete("spr_refresh_token");
  return response;
}
