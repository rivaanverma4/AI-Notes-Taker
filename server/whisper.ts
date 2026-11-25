import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import type { Readable } from "node:stream";
import { config } from "./config";
import { pcmToWav } from "./wav";

export type WhisperStatus = "starting" | "ready" | "error" | "missing";

const HALLUCINATION_PATTERNS = [
  /^thanks? for watching[.!]?$/i,
  /^thank you for watching[.!]?$/i,
  /^please subscribe.*$/i,
  /^subscribe to my channel.*$/i,
  /^\[?blank_audio\]?$/i,
  /^\(?silence\)?$/i,
  /^you$/i,
  /^\.+$/,
];

function isPortOpen(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function cleanTranscript(text: string): string {
  let clean = text
    .replace(/\[(?:blank_audio|silence|music|applause|inaudible)\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (HALLUCINATION_PATTERNS.some((pattern) => pattern.test(clean))) return "";
  return clean;
}

function isRecoverableWhisperError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode =
    cause && typeof cause === "object"
      ? String((cause as { code?: string }).code ?? "")
      : String(cause ?? "");
  return (
    error.name === "AbortError" ||
    /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|timed out/i.test(
      `${error.message} ${causeCode}`,
    )
  );
}

export class WhisperService {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private logTail: string[] = [];
  private statusValue: WhisperStatus = "starting";
  private messageValue = "Preparing the local transcription model…";
  private startPromise: Promise<void> | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  get status(): WhisperStatus {
    return this.statusValue;
  }

  get message(): string {
    return this.messageValue;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /**
   * Make sure the local Whisper server is actually listening. If it was
   * stopped or crashed, start it again. This is what prevents a stale
   * "ready" status from turning into a raw `fetch failed` during a lecture.
   */
  async ensureReady(): Promise<boolean> {
    if (await isPortOpen(config.whisper.port)) {
      this.statusValue = "ready";
      this.messageValue = "Local Whisper server is ready.";
      return true;
    }
    if (this.statusValue === "ready") {
      this.statusValue = "starting";
      this.messageValue = "Restarting the local transcription service…";
    }
    this.stopping = false;
    try {
      await this.start();
    } catch (error) {
      console.error("[whisper] failed to start:", error);
      this.statusValue = "error";
      this.messageValue =
        "The local transcription service could not start. Run `npm run setup:whisper` and restart the app.";
      return false;
    }
    return this.isReady();
  }

  private isReady(): boolean {
    return this.statusValue === "ready";
  }

  /** Restart a server that is listening but no longer responding. */
  async restart(): Promise<boolean> {
    this.statusValue = "starting";
    this.messageValue = "Restarting the local transcription service…";
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.stopping = false;
    return this.ensureReady();
  }

  private async startInternal(): Promise<void> {
    if (await isPortOpen(config.whisper.port)) {
      this.statusValue = "ready";
      this.messageValue = "Local Whisper server is ready.";
      return;
    }

    if (!existsSync(config.whisper.bin)) {
      this.statusValue = "missing";
      this.messageValue =
        "Whisper is not installed. Run `npm run setup:whisper` in the project folder.";
      return;
    }
    if (!existsSync(config.whisper.model)) {
      this.statusValue = "missing";
      this.messageValue =
        "The Whisper model is missing. Run `npm run setup:whisper` to download it.";
      return;
    }

    this.statusValue = "starting";
    this.messageValue = "Loading the local Whisper model…";

    const args = [
      "-m",
      config.whisper.model,
      "-l",
      config.whisper.language,
      "-nt",
      "-t",
      String(config.whisper.threads),
      "--host",
      "127.0.0.1",
      "--port",
      String(config.whisper.port),
    ];

    const child = spawn(config.whisper.bin, args, {
      cwd: config.root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let spawnError: string | null = null;

    child.once("error", (error) => {
      spawnError = error.message;
      console.error("[whisper] spawn error:", error);
      this.statusValue = "error";
      this.messageValue =
        "The local transcription service could not start. Run `npm run setup:whisper` and restart the app.";
    });

    const capture = (data: Buffer) => {
      const lines = data.toString().split(/\r?\n/).filter(Boolean);
      this.logTail.push(...lines);
      if (this.logTail.length > 40) this.logTail.splice(0, this.logTail.length - 40);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      const wasReady = this.statusValue === "ready";
      this.statusValue = "error";
      this.messageValue = wasReady
        ? "The local transcription service stopped. Restarting automatically…"
        : `Whisper exited while starting (${signal ?? code}). ` +
          (this.logTail.at(-1) ?? "Check the model and binary paths.");
      if (wasReady) {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopping) void this.ensureReady();
        }, 1_200);
      }
    });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await isPortOpen(config.whisper.port)) {
        // Give the HTTP listener a moment to become fully ready.
        await new Promise((resolve) => setTimeout(resolve, 350));
        this.statusValue = "ready";
        this.messageValue = "Local Whisper is ready. Audio never leaves this Mac.";
        return;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    this.statusValue = "error";
    this.messageValue =
      "Whisper did not finish loading. Check the terminal output for details.";
    this.stop();
  }

  async transcribe(
    pcm: Buffer,
    options: { prompt?: string; language?: string } = {},
  ): Promise<string> {
    if (pcm.length < 3_200) return "";
    if (this.statusValue !== "ready") {
      const ready = await this.ensureReady();
      if (!ready) {
        throw new Error(this.messageValue || "Whisper is not ready.");
      }
    }

    try {
      return await this.transcribeOnce(pcm, options);
    } catch (error) {
      if (!isRecoverableWhisperError(error)) {
        throw error instanceof Error ? error : new Error("Transcription failed.");
      }
      console.warn(
        "[whisper] connection lost; restarting the local server and retrying this segment.",
      );
      const ready = await this.restart();
      if (!ready) {
        throw new Error(
          "The local transcription service stopped and could not restart. " +
            "Your audio is saved; restart the app and reopen this lecture.",
        );
      }
      try {
        return await this.transcribeOnce(pcm, options);
      } catch (retryError) {
        throw new Error(
          "The local transcription service is still recovering. " +
            "Your audio is saved; transcription will resume with the next segment.",
        );
      }
    }
  }

  private async transcribeOnce(
    pcm: Buffer,
    options: { prompt?: string; language?: string } = {},
  ): Promise<string> {
    const wav = pcmToWav(pcm, config.sampleRate);
    const arrayBuffer = new ArrayBuffer(wav.byteLength);
    new Uint8Array(arrayBuffer).set(wav);
    const form = new FormData();
    form.append("file", new Blob([arrayBuffer], { type: "audio/wav" }), "audio.wav");
    form.append("temperature", "0.0");
    form.append("temperature_inc", "0.2");
    form.append("response_format", "json");
    if (options.prompt) form.append("prompt", options.prompt.slice(-300));
    if (options.language) form.append("language", options.language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${config.whisper.url}/inference`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Whisper returned HTTP ${response.status}.`);
      }
      const data = (await response.json()) as
        | { text?: string }
        | Array<{ text?: string }>
        | string;
      let text = "";
      if (typeof data === "string") text = data;
      else if (Array.isArray(data)) {
        text = data.map((item) => item.text ?? "").join(" ");
      } else {
        text = data.text ?? "";
      }
      return cleanTranscript(text);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Whisper timed out while processing this audio segment.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    if (this.statusValue === "ready") this.statusValue = "error";
  }
}

export const whisper = new WhisperService();
