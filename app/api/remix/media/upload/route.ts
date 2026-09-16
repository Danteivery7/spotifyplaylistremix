import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function engineUrl() {
  return (process.env.AUDIO_ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, "");
}

export async function POST(request: NextRequest) {
  let input: FormData;
  try {
    input = await request.formData();
  } catch {
    return NextResponse.json({ error: "The audio upload was not valid form data." }, { status: 400 });
  }

  const file = input.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "Choose one audio file to upload." }, { status: 400 });
  }

  const outgoing = new FormData();
  outgoing.append("file", file, file.name);

  try {
    const response = await fetch(`${engineUrl()}/media/upload`, {
      method: "POST",
      body: outgoing,
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json(
      { error: "Audio engine is offline. The upload library cannot be reached yet." },
      { status: 503 },
    );
  }
}
