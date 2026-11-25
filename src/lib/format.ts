import type { LectureSummary } from "../types";

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

export function relativeUpdated(iso: string | null): string {
  if (!iso) return "Not generated yet";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 45_000) return "Updated just now";
  if (diff < 3_600_000) return `Updated ${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `Updated ${Math.floor(diff / 3_600_000)}h ago`;
  return `Updated ${formatDate(iso)}`;
}

export function groupLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "Earlier this week";
  if (date.getFullYear() === today.getFullYear()) {
    return new Intl.DateTimeFormat("en-US", { month: "long" }).format(date);
  }
  return String(date.getFullYear());
}

export function groupLectures(
  lectures: LectureSummary[],
): Array<{ label: string; lectures: LectureSummary[] }> {
  const groups = new Map<string, LectureSummary[]>();
  for (const lecture of lectures) {
    const label = groupLabel(lecture.created_at);
    const list = groups.get(label) ?? [];
    list.push(lecture);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, lectures: items }));
}

export function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^#\s+.+\n+/, "").trim();
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function statusLabel(status: LectureSummary["status"]): string {
  switch (status) {
    case "recording":
      return "Recording";
    case "paused":
      return "Paused";
    case "processing":
      return "Writing notes";
    case "interrupted":
      return "Needs finishing";
    default:
      return "Saved";
  }
}
