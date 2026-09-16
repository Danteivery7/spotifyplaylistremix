# Playlist Remix Studio

A modern Rave.dj-style long-form remix system: paste a Spotify playlist, analyze the songs from an **authorized local audio library**, intelligently select substantial portions of each track, plan compatible transitions, and render one long mix plus an optional 16:9 video.

## What is implemented

- Clean one-link Next.js 16 interface.
- Spotify OAuth and the **2026** playlist `/items` API shape.
- Playlist import for playlists the connected user owns or collaborates on.
- Automatic matching of playlist tracks against an authorized local media library.
- Real audio analysis with librosa 1.0: BPM, key, RMS energy, onset strength and duration.
- Smart ordering based on tempo/key/energy compatibility.
- Rave-style song windows: defaults to roughly **1:32–2:22 per track** rather than full songs or tiny clips.
- Adaptive 6–18 second transitions.
- FFmpeg long-form audio rendering at 320 kbps AAC.
- Optional 1920×1080 H.264 video rendering.
- Optional BS-RoFormer stem-separation adapter using `audio-separator` for a later stem-aware transition renderer.

## Important source rule

Spotify is used for playlist metadata and attribution. This project **does not download or stream-rip Spotify audio**. Put audio you own or are licensed to process in `./media`; the engine matches those files to the playlist automatically. This keeps the architecture reliable and aligned with Spotify's platform rules.

Spotify's current development-mode API only exposes playlist contents for playlists owned by the connected user or playlists where that user is a collaborator. The Spotify app owner must also satisfy Spotify's current development-mode account requirements.

## Local setup

### 1. Spotify app

Create a Spotify developer app and set this redirect URI:

```text
http://localhost:3000/api/spotify/callback
```

Copy `.env.example` to `.env.local` and fill in:

```bash
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://localhost:3000/api/spotify/callback
NEXT_PUBLIC_APP_URL=http://localhost:3000
AUDIO_ENGINE_URL=http://localhost:8000
```

### 2. Web app

```bash
npm install
npm run dev
```

### 3. Audio engine

Put authorized song files in `./media`. Helpful file names are like:

```text
Artist - Song Title.flac
Artist - Song Title.mp3
```

Then run:

```bash
docker compose up --build
```

Or directly:

```bash
cd engine
python -m venv .venv
# activate the environment
pip install -e .
uvicorn app.main:app --reload --port 8000
```

### 4. Use it

1. Open `http://localhost:3000`.
2. Connect Spotify.
3. Paste a playlist you own/collaborate on.
4. Click **Create remix**.
5. Click **Start engine** once the playlist preview is loaded.
6. The engine resolves files from `./media`, analyzes them, plans the mix, and writes output under `engine/output`.

## Stem separation

The repository includes a feature-flagged BS-RoFormer integration point. For GPU-heavy stem work:

```bash
cd engine
pip install -e '.[stems]'
ENABLE_STEMS=true
```

The current renderer intentionally uses robust whole-track crossfades. The next audio milestone is to feed the separated vocal/instrumental stems into the transition renderer so compatible transitions can use vocal handoffs, instrumental swaps, and drum-led blends instead of forcing every transition through the same effect.

## Architecture

```text
Spotify playlist URL
        │
        ▼
Next.js / Spotify OAuth
        │ metadata only
        ▼
Playlist payload
        │
        ▼
FastAPI audio engine
  ├─ local-library resolver
  ├─ librosa analysis
  ├─ compatibility planner
  ├─ optional BS-RoFormer stems
  └─ FFmpeg renderer
        │
        ├─ .m4a long-form mix
        └─ .mp4 1920×1080 video
```

## Roadmap

The foundation is deliberately structured so the next upgrades do not require rewriting the product:

- stem-aware transition rendering
- section/chorus detection and phrase-aligned edit points
- job persistence + progress streaming
- direct uploads/object storage instead of only a local media folder
- visualizer + current-track titles in the rendered video
- loudness normalization and mastering pass
- optional manual transition review without making manual DJ work mandatory
