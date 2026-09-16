const ACCESS_TOKEN_KEY = "spr_access_token";
const REFRESH_TOKEN_KEY = "spr_refresh_token";
const EXPIRES_AT_KEY = "spr_expires_at";
const CLIENT_ID_KEY = "spr_client_id";
const VERIFIER_KEY = "spr_code_verifier";
const STATE_KEY = "spr_oauth_state";
const PENDING_PLAYLIST_KEY = "spr_pending_playlist";

const FALLBACK_CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? "";

function browserStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function sessionStorageSafe() {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomVerifier(length = 96) {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => charset[byte % charset.length]).join("");
}

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function tokenPayload(response: Response) {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`Spotify returned an unreadable token response (${response.status}).`);
  }
  if (!response.ok) {
    const message = typeof payload.error_description === "string"
      ? payload.error_description
      : typeof payload.error === "string"
        ? payload.error
        : `Spotify authorization failed (${response.status}).`;
    throw new Error(message);
  }
  return payload;
}

function storeTokens(payload: Record<string, unknown>) {
  const storage = browserStorage();
  if (!storage || typeof payload.access_token !== "string") return;
  storage.setItem(ACCESS_TOKEN_KEY, payload.access_token);
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  storage.setItem(EXPIRES_AT_KEY, String(Date.now() + Math.max(60, expiresIn - 60) * 1000));
  if (typeof payload.refresh_token === "string" && payload.refresh_token) {
    storage.setItem(REFRESH_TOKEN_KEY, payload.refresh_token);
  }
}

export function getSpotifyClientId() {
  const storage = browserStorage();
  return storage?.getItem(CLIENT_ID_KEY)?.trim() || FALLBACK_CLIENT_ID.trim() || null;
}

export function saveSpotifyClientId(clientId: string) {
  const normalized = clientId.trim();
  if (!normalized) throw new Error("Paste your Spotify Client ID first.");
  browserStorage()?.setItem(CLIENT_ID_KEY, normalized);
  return normalized;
}

export function spotifyRedirectUri() {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/`;
}

export function rememberPendingPlaylist(url: string) {
  if (url.trim()) sessionStorageSafe()?.setItem(PENDING_PLAYLIST_KEY, url.trim());
}

export function takePendingPlaylist() {
  const storage = sessionStorageSafe();
  const value = storage?.getItem(PENDING_PLAYLIST_KEY) ?? null;
  if (value) storage?.removeItem(PENDING_PLAYLIST_KEY);
  return value;
}

export async function beginSpotifyLogin(clientIdInput?: string) {
  if (typeof window === "undefined") return;
  const clientId = clientIdInput ? saveSpotifyClientId(clientIdInput) : getSpotifyClientId();
  if (!clientId) throw new Error("Spotify needs a Client ID before it can connect.");

  const verifier = randomVerifier();
  const state = crypto.randomUUID();
  const challenge = await challengeFor(verifier);
  sessionStorageSafe()?.setItem(VERIFIER_KEY, verifier);
  sessionStorageSafe()?.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "playlist-read-private playlist-read-collaborative",
    redirect_uri: spotifyRedirectUri(),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    show_dialog: "false",
  });
  window.location.assign(`https://accounts.spotify.com/authorize?${params.toString()}`);
}

export async function completeSpotifyLoginFromUrl() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error) {
    window.history.replaceState({}, "", window.location.pathname);
    throw new Error(error === "access_denied" ? "Spotify connection was cancelled." : `Spotify authorization failed: ${error}`);
  }

  const code = params.get("code");
  if (!code) return false;
  const returnedState = params.get("state");
  const expectedState = sessionStorageSafe()?.getItem(STATE_KEY);
  const verifier = sessionStorageSafe()?.getItem(VERIFIER_KEY);
  const clientId = getSpotifyClientId();
  if (!returnedState || returnedState !== expectedState || !verifier || !clientId) {
    window.history.replaceState({}, "", window.location.pathname);
    throw new Error("Spotify sign-in could not be verified. Start the connection again.");
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: spotifyRedirectUri(),
      code_verifier: verifier,
    }),
  });
  const payload = await tokenPayload(response);
  storeTokens(payload);
  sessionStorageSafe()?.removeItem(VERIFIER_KEY);
  sessionStorageSafe()?.removeItem(STATE_KEY);
  window.history.replaceState({}, "", window.location.pathname);
  return true;
}

export async function ensureSpotifyAccessToken() {
  const storage = browserStorage();
  if (!storage) return null;
  const accessToken = storage.getItem(ACCESS_TOKEN_KEY);
  const expiresAt = Number(storage.getItem(EXPIRES_AT_KEY) ?? 0);
  if (accessToken && expiresAt > Date.now() + 30_000) return accessToken;

  const refreshToken = storage.getItem(REFRESH_TOKEN_KEY);
  const clientId = getSpotifyClientId();
  if (!refreshToken || !clientId) {
    if (accessToken) storage.removeItem(ACCESS_TOKEN_KEY);
    return null;
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  if (!response.ok) {
    disconnectSpotify();
    return null;
  }
  const payload = await tokenPayload(response);
  storeTokens(payload);
  return typeof payload.access_token === "string" ? payload.access_token : null;
}

export function disconnectSpotify() {
  const storage = browserStorage();
  storage?.removeItem(ACCESS_TOKEN_KEY);
  storage?.removeItem(REFRESH_TOKEN_KEY);
  storage?.removeItem(EXPIRES_AT_KEY);
}
