import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const connected = Boolean(cookieStore.get("spr_access_token")?.value);
  return NextResponse.json({ connected }, { headers: { "cache-control": "no-store" } });
}
