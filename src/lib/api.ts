import type {
  Lecture,
  LectureDetail,
  LectureSummary,
  SystemStatus,
} from "../types";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function getSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>("/api/system");
}

export interface PrepareResult extends SystemStatus {
  ready: boolean;
}

/**
 * Wake the local Whisper and Ollama services before recording. Whisper is
 * required for transcription; Ollama is warmed in the background.
 */
export async function prepareServices(): Promise<PrepareResult> {
  return request<PrepareResult>("/api/prepare", { method: "POST" });
}

export async function getLectures(query = ""): Promise<LectureSummary[]> {
  const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const data = await request<{ lectures: LectureSummary[] }>(`/api/lectures${params}`);
  return data.lectures;
}

export async function getLecture(id: string): Promise<LectureDetail> {
  return request<LectureDetail>(`/api/lectures/${encodeURIComponent(id)}`);
}

export async function patchLecture(
  id: string,
  patch: { title?: string; notes_markdown?: string },
): Promise<Lecture> {
  const data = await request<{ lecture: Lecture }>(
    `/api/lectures/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return data.lecture;
}

export async function removeLecture(id: string): Promise<void> {
  await request(`/api/lectures/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function regenerateNotes(id: string): Promise<Lecture> {
  const data = await request<{ lecture: Lecture }>(
    `/api/lectures/${encodeURIComponent(id)}/regenerate`,
    { method: "POST" },
  );
  return data.lecture;
}

export async function finalizeLecture(id: string): Promise<Lecture> {
  const data = await request<{ lecture: Lecture }>(
    `/api/lectures/${encodeURIComponent(id)}/finalize`,
    { method: "POST" },
  );
  return data.lecture;
}

export function downloadMarkdown(id: string): void {
  const link = document.createElement("a");
  link.href = `/api/lectures/${encodeURIComponent(id)}/export.md`;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function audioUrl(id: string): string {
  return `/api/lectures/${encodeURIComponent(id)}/audio`;
}
