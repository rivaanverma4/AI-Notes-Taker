# Lecture Notes AI

A private, fully local lecture recorder for macOS. Record a lecture, watch the transcript appear, and get structured study notes written by models running on your own Mac. No cloud service, no API keys, and no audio leaves the machine.

**Local-first · Offline · Whisper + Qwen2.5**

## What it does

- Records real microphone audio with **Start**, **Pause**, **Resume**, and **Stop**.
- Transcribes speech locally in real time with **whisper.cpp** (Metal accelerated).
- Writes and continuously updates structured notes with a local **Ollama** model.
- Autosaves the title, date, duration, transcript, notes, and WAV audio.
- Reopen, rename, edit, search, and delete lectures.
- Export study notes as **Markdown** or **PDF**.
- Recovers gracefully when a local service stops: Whisper restarts, Ollama starts automatically, and the current segment is retried. Audio is always kept on disk.

## Requirements

- macOS on Apple Silicon (tested on an M3 with 16 GB RAM).
- Node.js 22 or newer.
- [Ollama](https://ollama.com/) installed.
- Xcode Command Line Tools (`xcode-select --install`).
- About 2 GB free for the Whisper model and Ollama models.
- Internet access **only for initial setup**. After that, the app runs offline.

## Quick start

```bash
cd lecture-notes-ai
npm install

# Build the Metal whisper-server and download the 834 MB model once.
npm run setup:whisper

# Download the local note model once.
ollama pull qwen2.5:3b

# Start the app (API + Vite dev server).
npm run dev
```

Open <http://localhost:5173> and allow microphone access.

For a production-style run served entirely from port 3001:

```bash
npm run build
npm start
# open http://127.0.0.1:3001
```

The first recording may take a few seconds longer while Whisper and Ollama load their models. The app shows a “Waking up the local models…” screen and keeps the models warm afterward.

## Local models

| Purpose | Default | Notes |
| --- | --- | --- |
| Speech to text | `ggml-large-v3-turbo-q8_0.bin` | Downloaded by `npm run setup:whisper`; runs through whisper.cpp with Metal. |
| Live notes | `qwen2.5:3b` | Fast enough to update notes while recording on a 16 GB Mac. |
| Final notes | `qwen2.5:3b` | A fresh, stricter pass over the full transcript. `qwen2.5:7b` is optional but much slower and was not more accurate in testing. |

To use different models, copy `.env.example` to `.env` and edit:

```bash
OLLAMA_LIVE_MODEL=qwen2.5:3b
OLLAMA_FINAL_MODEL=qwen2.5:3b
```

If the requested final model is not installed, the app falls back to the live model automatically.

## How it works

```text
Microphone
   │  AudioWorklet, 16 kHz mono PCM
   ▼
Browser ── WebSocket ──► Node/Express server
                              │
                              ├─► VAD chunker ─► local whisper-server ─► transcript
                              │
                              ├─► rolling note engine ─► local Ollama ─► live notes
                              │
                              └─► SQLite + WAV files in ./data
```

- Audio is streamed to the local server over loopback only.
- Speech is split at natural pauses, so each transcription request stays small.
- Notes are generated on a rolling cadence and merged without dropping earlier material.
- Every generated note passes through a deterministic transcript-grounding filter. Sentences containing facts the lecturer did not say are removed before saving. If grounding removes too much (for example, a very short or noisy recording), the app falls back to a faithful transcript outline instead of saving blank or invented notes.
- Long lectures use a merge pass so earlier material is not lost to the context window.

## Data and privacy

Everything lives in `./data` by default:

```text
data/
├── lecture-notes.db      SQLite database (lectures, transcripts, notes)
└── audio/                One WAV file per lecture
```

- The server binds to `127.0.0.1` only.
- Ollama and Whisper are contacted at loopback addresses only.
- There is no telemetry, account, upload, or API key.
- To back up the library, copy the whole `data` folder while the app is stopped.
- Deleting a lecture from the UI removes its database row and audio file.

## Offline verification

1. Finish the setup steps above while online.
2. Turn off Wi-Fi / disconnect Ethernet.
3. Start the app and record a short lecture.
4. Confirm transcription, live notes, final notes, search, and exports still work.

The only network requests the app makes are to `127.0.0.1` (the app server, Whisper, and Ollama).

## Troubleshooting

### “A local model reported a problem”

The app now self-heals instead of showing a raw `fetch failed` error:

- If Whisper dies, the server restarts it and retries the affected audio segment.
- If Ollama is stopped, the server launches the Ollama app (or `ollama serve`) and retries note generation.
- If a note update still fails, the transcript is preserved and the app shows a friendly warning. The next update or finalization retries.

If the warning persists:

```bash
ollama list
ollama serve
curl http://127.0.0.1:11434/api/tags
```

Check the terminal running the app for `[whisper]` or `[ollama]` messages.

### “Whisper is not installed” / model missing

```bash
npm run setup:whisper
```

This builds `.tools/whisper.cpp/build/bin/whisper-server` and downloads `models/ggml-large-v3-turbo-q8_0.bin`.

### Ollama model missing

```bash
ollama pull qwen2.5:3b
```

### Microphone access denied

Use Chrome, Edge, or Safari on `localhost` / `127.0.0.1`. Click the lock icon in the address bar, allow the microphone, and reload. Make sure no other app is holding the microphone.

### Notes are slow or the Mac is under memory pressure

A 3B model at 8k context uses roughly 2–3 GB. Close memory-heavy apps, keep the model warm, and avoid running `qwen2.5:7b` on a 16 GB machine while recording. The app intentionally keeps the model loaded between lectures to avoid expensive reloads.

### A lecture says “Interrupted” or “Needs finishing”

If the app was closed during a recording, the lecture is marked interrupted on startup and its WAV header is repaired. Open the lecture and choose **Regenerate notes**; the saved transcript and audio are still there.

## Development

```bash
npm run dev          # API + Vite with hot reload
npm run dev:server   # API only (tsx watch)
npm run dev:client   # Vite only
npm run build        # Type-check and build the production UI
npm start            # Production API + built UI on port 3001
npm test             # Vitest (if tests are added)
```

Useful endpoints:

- `GET /api/system` – local service health
- `POST /api/prepare` – wake Whisper and Ollama before recording
- `GET /api/lectures?q=...` – search the library
- `GET /api/lectures/:id` – lecture, segments, transcript
- `PATCH /api/lectures/:id` – rename or edit notes
- `DELETE /api/lectures/:id` – delete lecture and audio
- `POST /api/lectures/:id/regenerate` – regenerate notes
- `GET /api/lectures/:id/export.md` – Markdown export
- `GET /api/lectures/:id/audio` – range-capable WAV streaming
- `WS /ws/record` – start a new recording
- `WS /ws/record/:id` – resume an interrupted recording

## Project layout

```text
server/           Express API, WebSocket, VAD, Whisper/Ollama clients, notes engine
src/              React UI, recorder hook, Markdown/PDF rendering
shared/           Shared TypeScript types
scripts/          whisper.cpp setup and dev launcher
data/             Local SQLite database and WAV files (created at runtime)
.tools/           Project-local whisper.cpp build and CMake (created by setup)
models/           Local Whisper model (created by setup)
```

## License

Private project. Model weights retain their upstream licenses (whisper.cpp / OpenAI Whisper, Qwen2.5 / Alibaba Cloud).
