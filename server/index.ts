import { createServer } from "node:http";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import express from "express";
import type { Request, Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientEvent,
  Lecture,
  ServerEvent,
  SystemStatus,
  TranscriptSegment,
} from "../shared/types";
import { config } from "./config";
import {
  allLecturesWithAudio,
  db,
  deleteLecture,
  getLecture,
  getSegments,
  getTranscript,
  listLectures,
  recoverInterruptedLectures,
  setNotes,
  setTitle,
} from "./db";
import { ollama } from "./ollama";
import { regenerateLectureNotes } from "./notes";
import { RecordingSession, shutdownSessions } from "./session";
import { repairWavHeader } from "./wav";
import { whisper } from "./whisper";

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.audioDir, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatSegmentTimestamp(ms: number): string {
  return formatDuration(ms).padStart(5, "0");
}

function lectureMarkdown(lecture: Lecture, segments: TranscriptSegment[]): string {
  const date = new Date(lecture.created_at).toLocaleString();
  const notesBody = lecture.notes_markdown.replace(/^#\s+.+\n+/, "").trim();
  const transcript = segments
    .map(
      (segment) =>
        `**[${formatSegmentTimestamp(segment.start_ms)}]** ${segment.text}`,
    )
    .join("\n\n");
  return `---
title: ${JSON.stringify(lecture.title)}
date: ${JSON.stringify(date)}
duration: ${JSON.stringify(formatDuration(lecture.duration_ms))}
---

# ${lecture.title}

> Recorded ${date} · ${formatDuration(lecture.duration_ms)}

${notesBody || "_No notes were generated for this lecture._"}

---

## Full Transcript

${transcript || "_No speech was detected._"}
`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/system", async (_req, res) => {
  // Keep the local services alive. Starting them is idempotent and happens in
  // the background so this endpoint stays fast.
  void whisper.ensureReady();
  void ollama.ensureReady();
  const health = await ollama.refresh();
  const status: SystemStatus = {
    whisper: {
      status: whisper.status,
      message: whisper.message,
      model: path.basename(config.whisper.model),
    },
    ollama: {
      status: health.status,
      message: health.message,
      live_model: health.liveModel,
      final_model: health.finalModel,
      models: health.models,
    },
  };
  res.json(status);
});

app.post("/api/prepare", async (_req, res) => {
  // Whisper is required before recording can begin, so wait for it. Ollama is
  // only needed once the first chunk has been transcribed; wake it in the
  // background so recording starts quickly even after a fresh login.
  const whisperReady = await whisper.ensureReady();
  void ollama.ensureReady().then((ready) => {
    if (ready) void ollama.warmup();
  });
  const health = await ollama.refresh();
  const status: SystemStatus = {
    whisper: {
      status: whisper.status,
      message: whisper.message,
      model: path.basename(config.whisper.model),
    },
    ollama: {
      status: health.status,
      message: health.message,
      live_model: health.liveModel,
      final_model: health.finalModel,
      models: health.models,
    },
  };
  res.json({
    ...status,
    ready: whisperReady,
  });
});

app.get("/api/lectures", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  res.json({ lectures: listLectures(query) });
});

app.get("/api/lectures/:id", (req, res) => {
  const lecture = getLecture(req.params.id);
  if (!lecture) return sendError(res, 404, "Lecture not found.");
  res.json({ lecture, segments: getSegments(lecture.id) });
});

app.patch("/api/lectures/:id", (req, res) => {
  const lecture = getLecture(req.params.id);
  if (!lecture) return sendError(res, 404, "Lecture not found.");
  const active = RecordingSession.get(lecture.id);
  if (active && active.status !== "completed") {
    return sendError(res, 409, "Stop the recording before editing this lecture.");
  }

  if (typeof req.body?.title === "string") {
    setTitle(lecture.id, req.body.title, "user");
  }
  if (typeof req.body?.notes_markdown === "string") {
    setNotes(lecture.id, req.body.notes_markdown, lecture.last_error);
  }
  res.json({ lecture: getLecture(lecture.id) });
});

app.delete("/api/lectures/:id", (req, res) => {
  const lecture = getLecture(req.params.id);
  if (!lecture) return sendError(res, 404, "Lecture not found.");
  if (RecordingSession.get(lecture.id)) {
    return sendError(
      res,
      409,
      "Stop or finish the recording before deleting this lecture.",
    );
  }
  const deleted = deleteLecture(lecture.id);
  if (deleted?.audio_path) {
    try {
      unlinkSync(deleted.audio_path);
    } catch {
      // Audio may already be gone.
    }
  }
  res.json({ ok: true });
});

app.get("/api/lectures/:id/export.md", (req, res) => {
  const lecture = getLecture(req.params.id);
  if (!lecture) return sendError(res, 404, "Lecture not found.");
  const markdown = lectureMarkdown(lecture, getSegments(lecture.id));
  const safeName =
    lecture.title
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "lecture-notes";
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeName}.md"; filename*=UTF-8''${encodeURIComponent(
      `${lecture.title}.md`,
    )}`,
  );
  res.send(markdown);
});

app.get("/api/lectures/:id/audio", (req, res) => {
  const lecture = getLecture(req.params.id);
  if (!lecture?.audio_path || !existsSync(lecture.audio_path)) {
    return sendError(res, 404, "Audio not found.");
  }
  const size = statSync(lecture.audio_path).size;
  const range = req.headers.range;
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2]
        ? Math.min(Number.parseInt(match[2], 10), size - 1)
        : size - 1;
      if (start >= size || end < start) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(lecture.audio_path, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader("Content-Length", String(size));
  createReadStream(lecture.audio_path).pipe(res);
});

app.post("/api/lectures/:id/regenerate", async (req, res) => {
  const lecture = getLecture(req.params.id);
  if (!lecture) return sendError(res, 404, "Lecture not found.");
  if (RecordingSession.get(lecture.id)) {
    return sendError(res, 409, "This lecture is still recording.");
  }
  try {
    const updated = await regenerateLectureNotes(lecture.id);
    res.json({ lecture: updated });
  } catch (error) {
    sendError(
      res,
      500,
      error instanceof Error ? error.message : "Note generation failed.",
    );
  }
});

app.post("/api/lectures/:id/finalize", async (req, res) => {
  const lecture = getLecture(req.params.id);
  if (!lecture) return sendError(res, 404, "Lecture not found.");
  if (RecordingSession.get(lecture.id)) {
    return sendError(res, 409, "This lecture is still recording.");
  }
  try {
    const updated = await regenerateLectureNotes(lecture.id);
    res.json({ lecture: updated });
  } catch (error) {
    sendError(
      res,
      500,
      error instanceof Error ? error.message : "Note generation failed.",
    );
  }
});

// Production static build. In development Vite serves the UI.
if (existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
    res.sendFile(path.join(config.clientDist, "index.html"));
  });
}

app.use("/api", (_req, res) => {
  sendError(res, 404, "Endpoint not found.");
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // Ignore a socket that closed mid-send.
  }
}

function handleConnection(ws: WebSocket, lectureId: string | null): void {
  let session: RecordingSession | null = null;
  let starting = false;

  if (lectureId) {
    const lecture = getLecture(lectureId);
    if (!lecture) {
      send(ws, { type: "error", message: "Lecture not found." });
      ws.close(4004, "Lecture not found.");
      return;
    }
    session = RecordingSession.get(lectureId) ?? null;
    if (!session) {
      send(ws, {
        type: "error",
        message:
          "This recording is no longer attached to a live session. Open it from the library and finish note generation.",
      });
      ws.close(4004, "No live recording session.");
      return;
    }
    session.attach(ws);
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (session) session.handleAudio(Buffer.from(data as Buffer));
      return;
    }
    let event: ClientEvent;
    try {
      event = JSON.parse(data.toString()) as ClientEvent;
    } catch {
      send(ws, { type: "error", message: "Invalid WebSocket message." });
      return;
    }

    if (event.type === "start") {
      if (session) {
        send(ws, { type: "error", message: "Recording already started." });
        return;
      }
      if (starting) {
        send(ws, {
          type: "error",
          message: "The local transcription service is still starting. Please wait a moment.",
        });
        return;
      }
      starting = true;
      void (async () => {
        try {
          const ready = await whisper.ensureReady();
          if (ws.readyState !== 1) return;
          if (!ready) {
            send(ws, { type: "error", message: whisper.message });
            ws.close(1011, "Whisper not ready.");
            return;
          }
          session = RecordingSession.create();
          session.attach(ws);
          session.sendStarted();
        } catch (error) {
          send(ws, {
            type: "error",
            message:
              error instanceof Error ? error.message : "Could not start recording.",
          });
          ws.close(1011, "Could not start recording.");
        } finally {
          starting = false;
        }
      })();
      return;
    }

    if (!session) {
      send(ws, { type: "error", message: "No recording session is attached." });
      return;
    }

    if (event.type === "pause") {
      void session.pause();
    } else if (event.type === "resume") {
      void session.resume();
    } else if (event.type === "stop") {
      void session.stop();
    }
  });

  ws.on("close", () => {
    if (session) void session.detach(ws);
  });
  ws.on("error", (error) => {
    console.error("[ws] error:", error.message);
  });
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/ws/record")) {
    socket.destroy();
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const lectureId = parts.length >= 3 ? parts[2] : null;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
    handleConnection(ws, lectureId);
  });
});

async function start(): Promise<void> {
  const recovered = recoverInterruptedLectures();
  let repaired = 0;
  for (const lecture of allLecturesWithAudio()) {
    if (lecture.audio_path && existsSync(lecture.audio_path)) {
      repairWavHeader(lecture.audio_path, config.sampleRate);
      repaired += 1;
    }
  }
  if (recovered > 0) {
    console.log(`[db] Recovered ${recovered} interrupted lecture(s).`);
  }
  if (repaired > 0) {
    console.log(`[db] Verified ${repaired} audio file(s).`);
  }

  void ollama.ensureReady().then(() => {
    console.log(`[ollama] ${ollama.health.message}`);
  });
  void whisper.start();

  // Self-heal if either local service is stopped while the app is running.
  const healthTimer = setInterval(() => {
    if (whisper.status !== "ready") void whisper.ensureReady();
    void ollama.ping().then((ok) => {
      if (!ok) void ollama.ensureReady();
    });
  }, 20_000);
  healthTimer.unref();

  server.listen(config.port, config.host, () => {
    console.log(`[app] Lecture Notes AI is running at http://${config.host}:${config.port}`);
    console.log("[app] Everything stays on this Mac. No cloud services are used.");
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[app] ${signal} received. Saving open recordings...`);
  await shutdownSessions();
  whisper.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1_500);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void start();
