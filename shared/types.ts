export type LectureStatus =
  | "recording"
  | "paused"
  | "processing"
  | "completed"
  | "interrupted";

export type TitleSource = "auto" | "user";

export interface Lecture {
  id: string;
  title: string;
  title_source: TitleSource;
  status: LectureStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
  notes_markdown: string;
  notes_updated_at: string | null;
  audio_path: string | null;
  last_error: string | null;
  live_model: string | null;
  final_model: string | null;
}

export interface LectureSummary {
  id: string;
  title: string;
  status: LectureStatus;
  created_at: string;
  duration_ms: number;
  notes_updated_at: string | null;
  segment_count: number;
}

export interface TranscriptSegment {
  id: number;
  lecture_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  created_at: string;
}

export interface LectureDetail {
  lecture: Lecture;
  segments: TranscriptSegment[];
}

export interface SystemStatus {
  whisper: {
    status: "starting" | "ready" | "error" | "missing";
    message: string;
    model: string;
  };
  ollama: {
    status: "ready" | "unavailable";
    message: string;
    live_model: string;
    final_model: string;
    models: string[];
  };
}

export type RecordingState =
  | "idle"
  | "connecting"
  | "recording"
  | "paused"
  | "processing"
  | "completed";

export type ServerEvent =
  | { type: "started"; lecture: Lecture }
  | { type: "snapshot"; lecture: Lecture; segments: TranscriptSegment[] }
  | { type: "transcript"; segment: TranscriptSegment }
  | { type: "notes"; notes_markdown: string; title: string; notes_updated_at: string }
  | { type: "notes_status"; status: "generating" | "idle" }
  | { type: "status"; status: LectureStatus; duration_ms: number; message?: string }
  | { type: "warning"; message: string }
  | { type: "completed"; lecture: Lecture }
  | { type: "error"; message: string };

export type ClientEvent =
  | { type: "start"; title?: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" };
