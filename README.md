# Playlist Remix Studio

A long-form automatic remix system inspired by the simplicity of Rave.dj but built around a newer analysis, transition, stem-separation and mastering pipeline.

Paste a Spotify playlist, resolve the songs from an **authorized audio library**, analyze the music, keep substantial sections of each track, create musically planned transitions, master the full mix, and export audio plus a 16:9 video.

## Current quality pipeline

The current engine now includes:

- Spotify OAuth and the current playlist `/items` API shape.
- Automatic local-library matching for authorized audio.
- Beat, bar and tempo analysis with librosa.
- Musical-key estimation plus key-confidence scoring.
- Phrase and structural-section detection.
- Automatic section labels such as intro, verse, build, chorus/drop, breakdown and outro.
- Phrase-aligned song windows that still preserve roughly **1:32–2:22 per song**.
- Camelot-style harmonic compatibility scoring.
- Tempo, key, energy and rhythmic-stability transition scoring.
- Beam-search playlist ordering instead of one-step greedy ordering.
- Subtle automatic tempo matching, capped to small changes.
- Per-track level matching before transitions.
- Adaptive transition types, including longer harmonic blends and short clean handoffs.
- Optional BS-RoFormer / MelBand-RoFormer-compatible stem separation through `audio-separator`.
- Vocal-safe stem transitions that bring the incoming instrumental in before its full vocal mix.
- Stem caching so the same song is not separated repeatedly.
- Optional stem-model ensembling through `STEM_EXTRA_MODELS`.
- Equal-power FFmpeg transitions.
- Two-pass **EBU R128** mastering.
- Default final target of **-14 LUFS** with a **-1 dBTP** true-peak ceiling.
- 320 kbps AAC long-form output.
- 1920×1080 H.264 video with a live waveform.
- On-demand mastered previews for every planned transition.
- A final quality panel showing mastering targets and measured output loudness.
- CI planner tests plus a real synthesized FFmpeg render/master smoke test.

## Important source rule

Spotify is used for playlist metadata and attribution. This project **does not download or stream-rip Spotify audio**.

Put audio you own or are licensed to process in `./media`. Helpful file names look like:

```text
Artist - Song Title.flac
Artist - Song Title.mp3
```

The engine matches those files to the Spotify playlist.

## Local setup

### 1. Spotify app

Create a Spotify developer app and set:

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

### 3. Audio engine: standard mode

```bash
docker compose up --build
```

This runs the complete phrase-aware renderer and mastering pipeline without GPU stem separation. Stem-marked transitions automatically fall back to the full mix if stems are unavailable.

### 4. Audio engine: highest-quality GPU stem mode

For an NVIDIA Docker setup with GPU access:

```bash
INSTALL_STEMS=true ENABLE_STEMS=true \
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

The first stem transition may take longer because `audio-separator` downloads the configured model. Results are cached under `engine/stem-cache`.

Default model:

```text
model_bs_roformer_ep_317_sdr_12.9755.ckpt
```

You can override it:

```bash
STEM_MODEL=melband_roformer_big_beta4.ckpt
```

If the machine has enough VRAM, optional model ensembling is wired in:

```bash
STEM_EXTRA_MODELS=modelA.ckpt,modelB.ckpt
```

### 5. Use it

1. Open `http://localhost:3000`.
2. Click **Connect Spotify**.
3. Paste a playlist and click **Load Playlist**.
4. Confirm the tracks.
5. Click **Create My Mix**.
6. Watch the stages: Finding audio → Mapping phrases → Planning transitions → Rendering transitions → Mastering.
7. Download the mastered audio or video.
8. Use **Hear a transition preview** to audition any transition from the finished plan.

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
  ├─ authorized-library resolver
  ├─ beat / bar / key analysis
  ├─ phrase + section segmentation
  ├─ Camelot + tempo + energy scoring
  ├─ beam-search set planner
  ├─ optional RoFormer stem cache
  ├─ vocal-safe transition renderer
  ├─ FFmpeg lossless working mix
  ├─ two-pass EBU R128 mastering
  └─ transition-preview renderer
        │
        ├─ .m4a mastered mix
        └─ .mp4 1920×1080 waveform video
```

## Quality defaults

The automatic defaults are intentionally conservative:

- Song window: 92–142 seconds
- Base transition: ~12 seconds
- Long harmonic/stem blend: up to ~20 seconds
- Automatic tempo stretch: only when within ±4%
- Per-track gain correction: capped to ±5 dB
- Master target: -14 LUFS
- True-peak ceiling: -1 dBTP
- Preview length: ~28 seconds

The goal is not to force a flashy mashup on every pair. When two tracks are not musically compatible, the planner deliberately chooses a shorter, cleaner handoff.

## Tests

```bash
cd engine
pip install -e '.[dev]'
pytest -q
```

The tests cover harmonic compatibility, phrase-snapped windows, stem-transition planning, bounded gain matching, and a real FFmpeg render/master smoke test.

## Remaining product work

The core audio-intelligence layer is now implemented. The remaining work is mostly product and production infrastructure rather than fundamental mixing logic:

- persistent job storage instead of in-memory jobs
- upload/object-storage workflow for authorized audio
- cancellation and resumable renders
- GPU worker queue for large playlists
- richer current-track/video graphics
- optional manual transition override while preserving one-click automatic mode

No automatic DJ system can guarantee a subjectively perfect transition for every possible pair of songs. The engine is designed to avoid forcing bad combinations and to choose safer handoffs when the musical evidence is weak.
