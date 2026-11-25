import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Node 22 can load .env files natively. A missing .env is fine.
const envPath = path.join(root, ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Ignore malformed optional .env; defaults still work.
  }
}

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const dataDir = resolvePath(process.env.DATA_DIR ?? "./data");

export const config = {
  root,
  host: process.env.HOST ?? "127.0.0.1",
  port: int(process.env.PORT, 3001),
  dataDir,
  audioDir: path.join(dataDir, "audio"),
  dbPath: path.join(dataDir, "lecture-notes.db"),
  clientDist: path.join(root, "dist"),
  whisper: {
    bin: resolvePath(
      process.env.WHISPER_BIN ?? "./.tools/whisper.cpp/build/bin/whisper-server",
    ),
    model: resolvePath(
      process.env.WHISPER_MODEL ?? "./models/ggml-large-v3-turbo-q8_0.bin",
    ),
    port: int(process.env.WHISPER_PORT, 8081),
    language: process.env.WHISPER_LANGUAGE ?? "en",
    threads: int(process.env.WHISPER_THREADS, 6),
    get url() {
      return `http://127.0.0.1:${this.port}`;
    },
  },
  ollama: {
    url: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    liveModel: process.env.OLLAMA_LIVE_MODEL ?? "qwen2.5:3b",
    finalModel: process.env.OLLAMA_FINAL_MODEL ?? "qwen2.5:3b",
  },
  notes: {
    intervalMs: int(process.env.NOTES_INTERVAL_MS, 60_000),
    minChars: int(process.env.NOTES_MIN_CHARS, 450),
    // A 3B model on a 16 GB Mac does not need a 32k context for ordinary
    // lectures. A smaller KV cache leaves memory for Whisper and the OS.
    numCtx: int(process.env.NOTES_NUM_CTX, 8_192),
    maxNumCtx: int(process.env.NOTES_MAX_NUM_CTX, 32_768),
    numPredict: int(process.env.NOTES_NUM_PREDICT, 4096),
    liveNumPredict: int(process.env.NOTES_LIVE_NUM_PREDICT, 3_000),
    finalNumPredict: int(process.env.NOTES_FINAL_NUM_PREDICT, 5_000),
    liveTimeoutMs: int(process.env.NOTES_LIVE_TIMEOUT_MS, 120_000),
    finalTimeoutMs: int(process.env.NOTES_FINAL_TIMEOUT_MS, 240_000),
  },
  sampleRate: 16_000,
};
