export type PlaylistTrack = {
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  imageUrl: string | null;
  spotifyUrl: string;
  explicit?: boolean;
};

export type PlaylistPayload = {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  spotifyUrl: string;
  tracks: PlaylistTrack[];
  source?: "public_embed" | "spotify_api";
  truncated?: boolean;
};

export type RemixSettings = {
  targetMinSeconds: number;
  targetMaxSeconds: number;
  transitionSeconds: number;
  smartOrder: boolean;
  renderVideo: boolean;
};
