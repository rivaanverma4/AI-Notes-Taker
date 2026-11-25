import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  Lecture,
  LectureStatus,
  LectureSummary,
  TitleSource,
  TranscriptSegment,
} from "../shared/types";
import { config } from "./config";

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.audioDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS lectures (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    notes_markdown TEXT NOT NULL DEFAULT '',
    notes_updated_at TEXT,
    audio_path TEXT,
    last_error TEXT,
    live_model TEXT,
    final_model TEXT
  );

  CREATE TABLE IF NOT EXISTS transcript_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_segments_lecture
    ON transcript_segments(lecture_id, start_ms);

  CREATE INDEX IF NOT EXISTS idx_lectures_created
    ON lectures(created_at DESC);
`);

function now(): string {
  return new Date().toISOString();
}

export function defaultTitle(): string {
  return `Lecture — ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date())}`;
}

function asLecture(row: unknown): Lecture {
  return row as Lecture;
}

export function createLecture(): Lecture {
  const timestamp = now();
  const id = randomUUID();
  const title = defaultTitle();
  db.prepare(
    `INSERT INTO lectures
      (id, title, title_source, status, created_at, updated_at, started_at, live_model, final_model)
     VALUES (?, ?, 'auto', 'recording', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title,
    timestamp,
    timestamp,
    timestamp,
    config.ollama.liveModel,
    config.ollama.finalModel,
  );
  return getLecture(id)!;
}

export function getLecture(id: string): Lecture | null {
  const row = db.prepare("SELECT * FROM lectures WHERE id = ?").get(id);
  return row ? asLecture(row) : null;
}

export function listLectures(query = ""): LectureSummary[] {
  const q = query.trim();
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT
         l.id, l.title, l.status, l.created_at, l.duration_ms, l.notes_updated_at,
         (SELECT COUNT(*) FROM transcript_segments s WHERE s.lecture_id = l.id) AS segment_count
       FROM lectures l
       WHERE ? = ''
          OR l.title LIKE ? COLLATE NOCASE
          OR l.notes_markdown LIKE ? COLLATE NOCASE
          OR EXISTS (
            SELECT 1 FROM transcript_segments s2
            WHERE s2.lecture_id = l.id AND s2.text LIKE ? COLLATE NOCASE
          )
       ORDER BY l.created_at DESC`,
    )
    .all(q, like, like, like);
  return rows as unknown as LectureSummary[];
}

export function getSegments(lectureId: string): TranscriptSegment[] {
  return db
    .prepare(
      "SELECT * FROM transcript_segments WHERE lecture_id = ? ORDER BY start_ms ASC, id ASC",
    )
    .all(lectureId) as unknown as TranscriptSegment[];
}

export function getTranscript(lectureId: string): string {
  return getSegments(lectureId)
    .map((segment) => `[${formatTimestamp(segment.start_ms)}] ${segment.text}`)
    .join("\n");
}

export function addSegment(
  lectureId: string,
  startMs: number,
  endMs: number,
  text: string,
): TranscriptSegment {
  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO transcript_segments
        (lecture_id, start_ms, end_ms, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(lectureId, startMs, endMs, text, timestamp);
  db.prepare("UPDATE lectures SET updated_at = ? WHERE id = ?").run(
    timestamp,
    lectureId,
  );
  return {
    id: Number(result.lastInsertRowid),
    lecture_id: lectureId,
    start_ms: startMs,
    end_ms: endMs,
    text,
    created_at: timestamp,
  };
}

export function updateStatus(
  id: string,
  status: LectureStatus,
  extra?: { ended?: boolean; error?: string | null },
): Lecture {
  const timestamp = now();
  const endedAt = extra?.ended ? timestamp : null;
  db.prepare(
    `UPDATE lectures
     SET status = ?, updated_at = ?, ended_at = COALESCE(?, ended_at), last_error = ?
     WHERE id = ?`,
  ).run(status, timestamp, endedAt, extra?.error ?? null, id);
  return getLecture(id)!;
}

export function updateDuration(id: string, durationMs: number): void {
  db.prepare("UPDATE lectures SET duration_ms = ?, updated_at = ? WHERE id = ?").run(
    Math.max(0, Math.round(durationMs)),
    now(),
    id,
  );
}

export function setAudioPath(id: string, audioPath: string): void {
  db.prepare("UPDATE lectures SET audio_path = ?, updated_at = ? WHERE id = ?").run(
    audioPath,
    now(),
    id,
  );
}

export function setTitle(
  id: string,
  title: string,
  source: TitleSource = "auto",
): Lecture {
  const clean = title.trim().slice(0, 240) || defaultTitle();
  db.prepare(
    "UPDATE lectures SET title = ?, title_source = ?, updated_at = ? WHERE id = ?",
  ).run(clean, source, now(), id);
  return getLecture(id)!;
}

export function setNotes(id: string, markdown: string, error: string | null = null): Lecture {
  const timestamp = now();
  db.prepare(
    `UPDATE lectures
     SET notes_markdown = ?, notes_updated_at = ?, updated_at = ?, last_error = ?
     WHERE id = ?`,
  ).run(markdown, timestamp, timestamp, error, id);
  return getLecture(id)!;
}

export function setLastError(id: string, message: string | null): void {
  db.prepare("UPDATE lectures SET last_error = ?, updated_at = ? WHERE id = ?").run(
    message,
    now(),
    id,
  );
}

export function deleteLecture(id: string): Lecture | null {
  const lecture = getLecture(id);
  if (!lecture) return null;
  db.prepare("DELETE FROM lectures WHERE id = ?").run(id);
  return lecture;
}

export function recoverInterruptedLectures(): number {
  const rows = db
    .prepare(
      "SELECT id FROM lectures WHERE status IN ('recording', 'paused', 'processing')",
    )
    .all() as unknown as Array<{ id: string }>;
  const timestamp = now();
  for (const row of rows) {
    db.prepare(
      `UPDATE lectures
       SET status = 'interrupted', updated_at = ?,
           last_error = 'The app was closed before this lecture was finalized.'
       WHERE id = ?`,
    ).run(timestamp, row.id);
  }
  return rows.length;
}

export function allLecturesWithAudio(): Lecture[] {
  return db
    .prepare("SELECT * FROM lectures WHERE audio_path IS NOT NULL")
    .all() as unknown as Lecture[];
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
