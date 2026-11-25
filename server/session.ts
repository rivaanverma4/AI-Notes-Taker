import path from "node:path";
import type { WebSocket } from "ws";
import type {
  Lecture,
  LectureDetail,
  ServerEvent,
  TranscriptSegment,
} from "../shared/types";
import { config } from "./config";
import {
  addSegment,
  createLecture,
  getLecture,
  getSegments,
  setAudioPath,
  setLastError,
  updateDuration,
  updateStatus,
} from "./db";
import { NotesEngine } from "./notes";
import { VadChunker, type AudioSegment } from "./vad";
import { WavWriter } from "./wav";
import { whisper } from "./whisper";

const sessions = new Map<string, RecordingSession>();

function dedupeBoundary(previous: string, next: string): string {
  if (!previous) return next;
  const previousWords = previous.toLowerCase().split(/\s+/).filter(Boolean);
  const nextWords = next.split(/\s+/).filter(Boolean);
  if (nextWords.length < 4) return next;
  const maxOverlap = Math.min(18, previousWords.length, nextWords.length);
  for (let size = maxOverlap; size >= 4; size -= 1) {
    const left = previousWords.slice(-size).join(" ");
    const right = nextWords.slice(0, size).join(" ").toLowerCase();
    if (left === right) return nextWords.slice(size).join(" ");
  }
  return next;
}

export class RecordingSession {
  readonly lectureId: string;
  readonly audioPath: string;
  private ws: WebSocket | null = null;
  private writer: WavWriter;
  private chunker: VadChunker;
  private notesEngine: NotesEngine;
  private activeStartedAt: number | null = Date.now();
  private accumulatedMs = 0;
  private sttChain: Promise<void> = Promise.resolve();
  private pendingStt = 0;
  private lastText = "";
  private stopping = false;
  private statusValue: Lecture["status"] = "recording";

  constructor(lecture: Lecture) {
    this.lectureId = lecture.id;
    this.audioPath = path.join(config.audioDir, `${lecture.id}.wav`);
    this.writer = new WavWriter(this.audioPath, config.sampleRate);
    setAudioPath(lecture.id, this.audioPath);
    this.notesEngine = new NotesEngine(lecture.id, (event) => this.send(event));
    this.chunker = new VadChunker((segment) => this.queueSegment(segment));
  }

  static create(): RecordingSession {
    const lecture = createLecture();
    const session = new RecordingSession(lecture);
    sessions.set(lecture.id, session);
    return session;
  }

  static get(id: string): RecordingSession | undefined {
    return sessions.get(id);
  }

  static all(): RecordingSession[] {
    return [...sessions.values()];
  }

  get status(): Lecture["status"] {
    return this.statusValue;
  }

  get lecture(): Lecture {
    return getLecture(this.lectureId)!;
  }

  get durationMs(): number {
    return (
      this.accumulatedMs +
      (this.activeStartedAt ? Date.now() - this.activeStartedAt : 0)
    );
  }

  attach(ws: WebSocket): void {
    if (this.ws && this.ws !== ws) {
      try {
        this.ws.close(4000, "A newer recording window connected.");
      } catch {
        // Ignore.
      }
    }
    this.ws = ws;
    this.sendSnapshot();
  }

  async detach(ws: WebSocket): Promise<void> {
    if (this.ws !== ws) return;
    this.ws = null;
    if (this.statusValue === "recording") {
      await this.pause();
    }
  }

  sendSnapshot(): void {
    const lecture = getLecture(this.lectureId);
    if (!lecture) return;
    const detail: LectureDetail = {
      lecture,
      segments: getSegments(this.lectureId),
    };
    this.send({
      type: "snapshot",
      lecture: detail.lecture,
      segments: detail.segments,
    });
  }

  sendStarted(): void {
    const lecture = getLecture(this.lectureId);
    if (!lecture) return;
    this.send({ type: "started", lecture });
  }

  handleAudio(data: Buffer): void {
    if (this.statusValue !== "recording" || this.stopping) return;
    if (data.length < 2 || data.length % 2 !== 0) return;
    this.writer.append(data);
    this.chunker.push(data);
  }

  async pause(): Promise<void> {
    if (this.statusValue !== "recording") return;
    this.chunker.flush();
    if (this.activeStartedAt) {
      this.accumulatedMs += Date.now() - this.activeStartedAt;
      this.activeStartedAt = null;
    }
    this.statusValue = "paused";
    updateDuration(this.lectureId, this.durationMs);
    const lecture = updateStatus(this.lectureId, "paused", { error: null });
    this.send({
      type: "status",
      status: lecture.status,
      duration_ms: lecture.duration_ms,
    });
  }

  async resume(): Promise<void> {
    if (this.statusValue !== "paused") return;
    if (!(await whisper.ensureReady())) {
      this.send({ type: "error", message: whisper.message });
      return;
    }
    this.activeStartedAt = Date.now();
    this.statusValue = "recording";
    const lecture = updateStatus(this.lectureId, "recording", { error: null });
    this.send({
      type: "status",
      status: lecture.status,
      duration_ms: this.durationMs,
    });
  }

  async stop(): Promise<void> {
    if (this.stopping || this.statusValue === "processing") return;
    this.stopping = true;
    if (this.statusValue === "recording") {
      this.chunker.flush();
      if (this.activeStartedAt) {
        this.accumulatedMs += Date.now() - this.activeStartedAt;
        this.activeStartedAt = null;
      }
    }
    this.statusValue = "processing";
    updateDuration(this.lectureId, this.durationMs);
    updateStatus(this.lectureId, "processing", { error: null });
    this.send({
      type: "status",
      status: "processing",
      duration_ms: this.durationMs,
      message: "Finishing transcription and writing your final notes…",
    });

    // Wait for all queued speech chunks to finish transcribing.
    await this.sttChain;
    updateDuration(this.lectureId, this.durationMs);
    try {
      this.writer.finalize();
    } catch {
      // A damaged WAV header is repaired on next startup.
    }

    try {
      await this.notesEngine.finalize();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Final note generation failed.";
      setLastError(this.lectureId, message);
      const lecture = updateStatus(this.lectureId, "completed", {
        ended: true,
        error: message,
      });
      this.send({ type: "warning", message });
      this.send({ type: "completed", lecture });
    } finally {
      sessions.delete(this.lectureId);
    }
  }

  private queueSegment(segment: AudioSegment): void {
    this.pendingStt += 1;
    this.sttChain = this.sttChain
      .then(() => this.transcribe(segment))
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Transcription failed.";
        setLastError(this.lectureId, message);
        this.send({ type: "warning", message });
      })
      .finally(() => {
        this.pendingStt -= 1;
      });
  }

  private async transcribe(segment: AudioSegment): Promise<void> {
    if (!(await whisper.ensureReady())) {
      throw new Error(whisper.message || "Whisper is not ready.");
    }
    const text = await whisper.transcribe(segment.pcm, {
      prompt: this.lastText.slice(-240),
    });
    if (!text) return;
    const merged = dedupeBoundary(this.lastText, text).trim();
    if (!merged) return;
    this.lastText = merged;
    const saved = addSegment(
      this.lectureId,
      segment.startMs,
      segment.endMs,
      merged,
    );
    this.send({ type: "transcript", segment: saved });
    this.notesEngine.addSegment(saved);
  }

  private send(event: ServerEvent): void {
    if (!this.ws) return;
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(event));
    } catch {
      // The socket may have closed between the readyState check and send.
    }
  }

  finalizeForShutdown(): void {
    if (this.statusValue === "recording") {
      this.chunker.flush();
      if (this.activeStartedAt) {
        this.accumulatedMs += Date.now() - this.activeStartedAt;
        this.activeStartedAt = null;
      }
    }
    try {
      this.writer.finalize();
    } catch {
      // Ignore.
    }
  }
}

export async function shutdownSessions(): Promise<void> {
  for (const session of sessions.values()) {
    session.finalizeForShutdown();
  }
  sessions.clear();
}
