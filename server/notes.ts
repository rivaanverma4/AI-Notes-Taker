import type { Lecture, ServerEvent, TranscriptSegment } from "../shared/types";
import { config } from "./config";
import {
  formatTimestamp,
  getLecture,
  getSegments,
  getTranscript,
  setLastError,
  setNotes,
  setTitle,
  updateStatus,
} from "./db";
import { ollama } from "./ollama";
import { groundNotes } from "./grounding";
import {
  buildFinalNotesPrompt,
  buildInitialNotesPrompt,
  buildUpdateNotesPrompt,
  cleanGeneratedMarkdown,
  extractTitle,
  SYSTEM_PROMPT,
} from "./prompts";

type Broadcast = (event: ServerEvent) => void;

function batchText(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => {
      const totalSeconds = Math.floor(segment.start_ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}] ${segment.text}`;
    })
    .join("\n");
}

function segmentChars(segments: TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length + 10, 0);
}

/**
 * For lectures that fit comfortably in the local context window, generate the
 * final notes fresh from the transcript. This is more faithful than asking a
 * small model to rewrite its own live notes. Longer lectures merge into the
 * existing notes so earlier material is not lost to truncation.
 */
function buildFinalPrompt(
  latestNotes: string,
  transcript: string,
  title: string,
): string {
  if (latestNotes && transcript.length > 32_000) {
    return buildFinalNotesPrompt(latestNotes, transcript, title);
  }
  return buildInitialNotesPrompt(transcript);
}

/** Count actual note prose, ignoring headings, rules, and whitespace. */
function proseLength(markdown: string): number {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^#{1,6}\s+/.test(line) &&
        !/^[-*_]{3,}$/.test(line),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function hasUsableNotes(markdown: string, transcript: string): boolean {
  const prose = proseLength(markdown);
  if (prose < 160) return false;
  // A lecture with real content should produce notes proportional to it.
  if (transcript.length > 800 && prose < transcript.length * 0.06) return false;
  return true;
}

/**
 * The grounding filter is strict by design. For very short or messy audio it
 * can legitimately remove nearly everything the model wrote, leaving an empty
 * document. In that case, fall back to a faithful transcript outline instead of
 * saving blank notes or accepting invented material.
 */
function shouldUseExtractiveFallback(
  groundedMarkdown: string,
  rawMarkdown: string,
  transcript: string,
): boolean {
  const prose = proseLength(groundedMarkdown);
  if (prose < 160) return true;
  if (transcript.length > 800 && groundedMarkdown.length < rawMarkdown.length * 0.2) {
    return true;
  }
  return false;
}

function buildExtractiveNotes(
  segments: TranscriptSegment[],
  title: string,
): string {
  if (segments.length === 0) return "";
  const fullText = segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ");
  const sentences = fullText.match(/[^.!?]+[.!?]+/g) ?? [fullText];
  const overview = sentences
    .slice(0, 2)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);

  const blocks: Array<{ startMs: number; text: string }> = [];
  let current = "";
  let blockStart = segments[0].start_ms;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    if (!current) blockStart = segment.start_ms;
    current = current ? `${current} ${text}` : text;
    if (current.length >= 700) {
      blocks.push({ startMs: blockStart, text: current });
      current = "";
    }
  }
  if (current) blocks.push({ startMs: blockStart, text: current });

  const points = blocks
    .map((block) => `- **${formatTimestamp(block.startMs)}** ${block.text}`)
    .join("\n");

  return `# ${title}

## Overview
${overview || "A local transcript of this lecture is available below."}

## Lecture Notes
${points}

## Questions to Review
- Replay the audio for any terms or passages that were unclear in the transcript.`;
}

/**
 * Maintains one rolling set of notes for a lecture. Live updates merge new
 * transcript material into the complete document; finalization performs a
 * quality pass with the larger Ollama model.
 */
export class NotesEngine {
  private pending: TranscriptSegment[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private finalizing = false;
  private firstSegmentAt = 0;
  private lastRunAt = Date.now() - config.notes.intervalMs + 25_000;
  private notes: string;
  private title: string;

  constructor(
    private readonly lectureId: string,
    private readonly broadcast: Broadcast,
  ) {
    const lecture = getLecture(lectureId);
    this.notes = lecture?.notes_markdown ?? "";
    this.title = lecture?.title ?? "Lecture Notes";
  }

  addSegment(segment: TranscriptSegment): void {
    if (this.stopped) return;
    if (!this.firstSegmentAt) this.firstSegmentAt = Date.now();
    this.pending.push(segment);
    this.schedule();
  }

  private schedule(delayMs?: number): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);

    const chars = segmentChars(this.pending);
    const threshold = this.notes ? config.notes.minChars : Math.max(180, config.notes.minChars * 0.6);
    if (chars < threshold) {
      // Keep the material for finalization even if it is too short to summarize.
      return;
    }

    const due = this.notes
      ? this.lastRunAt + config.notes.intervalMs
      : Math.max(this.lastRunAt, this.firstSegmentAt + 18_000);
    const wait = delayMs ?? Math.max(1_500, due - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runLive();
    }, wait);
  }

  private async runLive(): Promise<void> {
    if (this.stopped || this.running || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.lastRunAt = Date.now();

    this.running = this.generateLive(batch).finally(() => {
      this.running = null;
      if (!this.stopped && this.pending.length > 0) this.schedule();
    });
    await this.running;
  }

  private async generateLive(batch: TranscriptSegment[]): Promise<void> {
    this.broadcast({ type: "notes_status", status: "generating" });
    try {
      const lecture = getLecture(this.lectureId);
      if (!lecture) throw new Error("Lecture not found.");
      const transcript = batchText(batch);
      const prompt = this.notes
        ? buildUpdateNotesPrompt(this.notes, transcript, this.title)
        : buildInitialNotesPrompt(transcript);

      const raw = await ollama.chat(
        ollama.liveModel,
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        {
          numPredict: config.notes.liveNumPredict,
          timeoutMs: config.notes.liveTimeoutMs,
          keepAlive: "30m",
        },
      );
      const cleaned = cleanGeneratedMarkdown(raw, this.title);
      const fullTranscript = getTranscript(this.lectureId);
      const grounded = groundNotes(cleaned, fullTranscript);
      if (grounded.removedSentences > 0) {
        console.log(
          `[notes] Live grounding removed ${grounded.removedSentences} unsupported sentence(s).`,
        );
      }
      let markdown = grounded.markdown;
      if (shouldUseExtractiveFallback(markdown, cleaned, fullTranscript)) {
        const fallback = hasUsableNotes(this.notes, fullTranscript)
          ? this.notes
          : buildExtractiveNotes(getSegments(this.lectureId), this.title);
        console.log(
          "[notes] Live output was not grounded enough; keeping the previous notes or a transcript outline.",
        );
        markdown = fallback;
      }
      const extracted = extractTitle(markdown);
      const latest = getLecture(this.lectureId);
      if (!latest) return;

      if (extracted && latest.title_source === "auto") {
        const updated = setTitle(this.lectureId, extracted, "auto");
        this.title = updated.title;
      } else {
        this.title = latest.title;
      }

      this.notes = markdown;
      const saved = setNotes(this.lectureId, markdown, null);
      this.broadcast({
        type: "notes",
        notes_markdown: markdown,
        title: this.title,
        notes_updated_at: saved.notes_updated_at ?? new Date().toISOString(),
      });
    } catch (error) {
      // Put the batch back so it is not lost. It will be retried or included in finalization.
      this.pending = [...batch, ...this.pending];
      const message =
        error instanceof Error ? error.message : "Live note generation failed.";
      this.broadcast({ type: "warning", message });
      setLastError(this.lectureId, message);
      if (!this.stopped) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.runLive();
        }, 20_000);
      }
    } finally {
      this.broadcast({ type: "notes_status", status: "idle" });
    }
  }

  async finalize(): Promise<Lecture> {
    if (this.finalizing) {
      throw new Error("Final note generation is already in progress.");
    }
    this.finalizing = true;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;

    const lecture = getLecture(this.lectureId);
    if (!lecture) throw new Error("Lecture not found.");
    const segments = getSegments(this.lectureId);
    const transcript = getTranscript(this.lectureId);
    const latestNotes = getLecture(this.lectureId)?.notes_markdown ?? this.notes;

    if (segments.length === 0) {
      const completed = updateStatus(this.lectureId, "completed", {
        ended: true,
        error: null,
      });
      this.broadcast({ type: "completed", lecture: completed });
      return completed;
    }

    this.broadcast({ type: "notes_status", status: "generating" });
    let markdown = latestNotes;
    let errorMessage: string | null = null;
    try {
      const prompt = buildFinalPrompt(latestNotes, transcript, lecture.title);
      const raw = await ollama.chat(
        ollama.finalModel,
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        {
          numPredict: config.notes.finalNumPredict,
          timeoutMs: config.notes.finalTimeoutMs,
          temperature: 0.1,
          keepAlive: "30m",
        },
      );
      const cleaned = cleanGeneratedMarkdown(raw, lecture.title);
      const grounded = groundNotes(cleaned, transcript);
      let finalMarkdown = grounded.markdown;
      if (grounded.removedSentences > 0 || grounded.removedLines > 0) {
        console.log(
          `[notes] Final grounding removed ${grounded.removedSentences} unsupported sentence(s) and ${grounded.removedLines} line(s).`,
        );
      }
      if (shouldUseExtractiveFallback(finalMarkdown, cleaned, transcript)) {
        finalMarkdown = hasUsableNotes(latestNotes, transcript)
          ? latestNotes
          : buildExtractiveNotes(segments, lecture.title);
        console.log(
          "[notes] Final output was not grounded enough; keeping the best available notes or a transcript outline.",
        );
      }
      markdown = finalMarkdown;
      const extracted = extractTitle(markdown);
      if (extracted && lecture.title_source === "auto") {
        this.title = setTitle(this.lectureId, extracted, "auto").title;
      } else {
        this.title = lecture.title;
      }
      setNotes(this.lectureId, markdown, null);
    } catch (error) {
      errorMessage =
        error instanceof Error
          ? `Final note generation failed: ${error.message}`
          : "Final note generation failed.";
      if (markdown) {
        setNotes(this.lectureId, markdown, errorMessage);
      } else {
        setLastError(this.lectureId, errorMessage);
      }
      this.broadcast({ type: "warning", message: errorMessage });
    }

    this.broadcast({ type: "notes_status", status: "idle" });
    const completed = updateStatus(this.lectureId, "completed", {
      ended: true,
      error: errorMessage,
    });
    this.broadcast({ type: "completed", lecture: completed });
    return completed;
  }
}

/**
 * Finalize or regenerate notes for a stored lecture that is not currently
 * attached to a live recording session.
 */
export async function regenerateLectureNotes(lectureId: string): Promise<Lecture> {
  const lecture = getLecture(lectureId);
  if (!lecture) throw new Error("Lecture not found.");
  const segments = getSegments(lectureId);
  const transcript = getTranscript(lectureId);

  if (segments.length === 0) {
    return updateStatus(lectureId, "completed", { ended: true, error: null });
  }

  updateStatus(lectureId, "processing", { error: null });
  try {
    const prompt = buildFinalPrompt(lecture.notes_markdown, transcript, lecture.title);
    const raw = await ollama.chat(
      ollama.finalModel,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      {
        numPredict: config.notes.finalNumPredict,
        timeoutMs: config.notes.finalTimeoutMs,
        temperature: 0.1,
        keepAlive: "30m",
      },
    );
    let markdown = cleanGeneratedMarkdown(raw, lecture.title);
    const grounded = groundNotes(markdown, transcript);
    let regenerated = grounded.markdown;
    if (grounded.removedSentences > 0 || grounded.removedLines > 0) {
      console.log(
        `[notes] Regeneration grounding removed ${grounded.removedSentences} unsupported sentence(s) and ${grounded.removedLines} line(s).`,
      );
    }
    if (shouldUseExtractiveFallback(regenerated, markdown, transcript)) {
      regenerated = hasUsableNotes(lecture.notes_markdown, transcript)
        ? lecture.notes_markdown
        : buildExtractiveNotes(segments, lecture.title);
      console.log(
        "[notes] Regenerated output was not grounded enough; keeping the best available notes or a transcript outline.",
      );
    }
    markdown = regenerated;
    const extracted = extractTitle(markdown);
    if (extracted && lecture.title_source === "auto") {
      setTitle(lectureId, extracted, "auto");
    }
    setNotes(lectureId, markdown, null);
    return updateStatus(lectureId, "completed", { ended: true, error: null });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Note generation failed.";
    if (lecture.notes_markdown) setNotes(lectureId, lecture.notes_markdown, message);
    else setLastError(lectureId, message);
    return updateStatus(lectureId, "completed", { ended: true, error: message });
  }
}
