export function extractSpotifyPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const uri = trimmed.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];

  try {
    const url = new URL(trimmed);
    if (!url.hostname.endsWith("spotify.com")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.indexOf("playlist");
    return index >= 0 ? parts[index + 1] ?? null : null;
  } catch {
    return null;
  }
}
