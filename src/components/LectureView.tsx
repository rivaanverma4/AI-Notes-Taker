import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileDown,
  FileText,
  Headphones,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { LectureDetail, LectureStatus } from "../types";
import {
  audioUrl,
  downloadMarkdown,
  finalizeLecture,
  getLecture,
  patchLecture,
  regenerateNotes,
  removeLecture,
} from "../lib/api";
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatTimestamp,
  statusLabel,
} from "../lib/format";
import { exportNotesPdf } from "../lib/pdf";
import { Markdown } from "./Markdown";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ToastKind } from "./Toast";

type Tab = "notes" | "transcript" | "audio";
type SaveState = "idle" | "saving" | "saved" | "error";

interface LectureViewProps {
  lectureId: string;
  onDeleted: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
}

function statusTone(status: LectureStatus): string {
  switch (status) {
    case "interrupted":
      return "warn";
    case "processing":
    case "recording":
    case "paused":
      return "live";
    default:
      return "ok";
  }
}

export function LectureView({
  lectureId,
  onDeleted,
  onClose,
  onChanged,
  onToast,
}: LectureViewProps) {
  const [detail, setDetail] = useState<LectureDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("notes");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleBusy, setTitleBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const pdfNotesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDetail(null);
    setEditing(false);
    setTab("notes");
    setMenuOpen(false);

    getLecture(lectureId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setDraft(data.lecture.notes_markdown);
        setTitleDraft(data.lecture.title);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(
          error instanceof Error ? error.message : "Could not open this lecture.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lectureId]);

  useEffect(() => {
    if (!editing || !detail) return;
    if (draft === detail.lecture.notes_markdown) return;

    setSaveState("saving");
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const updated = await patchLecture(detail.lecture.id, {
            notes_markdown: draft,
          });
          setDetail((current) =>
            current ? { ...current, lecture: updated } : current,
          );
          setSaveState("saved");
          onChanged();
        } catch (error) {
          setSaveState("error");
          onToast(
            error instanceof Error ? error.message : "Could not save your notes.",
            "error",
          );
        }
      })();
    }, 900);

    return () => window.clearTimeout(timer);
  }, [draft, editing, detail, onChanged, onToast]);

  const beginEditing = () => {
    if (!detail) return;
    setDraft(detail.lecture.notes_markdown);
    setSaveState("idle");
    setEditing(true);
    setTab("notes");
  };

  const finishEditing = async () => {
    if (!detail) return;
    if (draft === detail.lecture.notes_markdown) {
      setEditing(false);
      return;
    }
    setSaveState("saving");
    try {
      const updated = await patchLecture(detail.lecture.id, {
        notes_markdown: draft,
      });
      setDetail((current) =>
        current ? { ...current, lecture: updated } : current,
      );
      setSaveState("saved");
      setEditing(false);
      onChanged();
      onToast("Notes saved.", "success");
    } catch (error) {
      setSaveState("error");
      onToast(
        error instanceof Error ? error.message : "Could not save your notes.",
        "error",
      );
    }
  };

  const commitTitle = async () => {
    if (!detail || titleBusy) return;
    const title = titleDraft.trim();
    if (!title) {
      setTitleDraft(detail.lecture.title);
      setTitleEditing(false);
      return;
    }
    if (title === detail.lecture.title) {
      setTitleEditing(false);
      return;
    }
    setTitleBusy(true);
    try {
      const updated = await patchLecture(detail.lecture.id, { title });
      setDetail((current) =>
        current ? { ...current, lecture: updated } : current,
      );
      setTitleDraft(updated.title);
      setTitleEditing(false);
      onChanged();
      onToast("Lecture renamed.", "success");
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Could not rename this lecture.",
        "error",
      );
    } finally {
      setTitleBusy(false);
    }
  };

  const handleRegenerate = async () => {
    if (!detail || regenerating) return;
    const needsFinish =
      detail.lecture.status === "interrupted" ||
      detail.lecture.status === "processing";
    setConfirmRegenerate(false);
    setEditing(false);
    setMenuOpen(false);
    setRegenerating(true);
    try {
      const updated = needsFinish
        ? await finalizeLecture(detail.lecture.id)
        : await regenerateNotes(detail.lecture.id);
      setDetail((current) =>
        current ? { ...current, lecture: updated } : current,
      );
      setDraft(updated.notes_markdown);
      onChanged();
      if (updated.last_error) {
        onToast(updated.last_error, "error");
      } else {
        onToast(
          needsFinish ? "Final notes are ready." : "Notes regenerated.",
          "success",
        );
      }
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Note generation failed.",
        "error",
      );
    } finally {
      setRegenerating(false);
    }
  };

  const handleDelete = async () => {
    if (!detail || deleting) return;
    setDeleting(true);
    try {
      await removeLecture(detail.lecture.id);
      onDeleted(detail.lecture.id);
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "Could not delete this lecture.",
        "error",
      );
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleMarkdown = () => {
    if (!detail) return;
    downloadMarkdown(detail.lecture.id);
    onToast("Markdown download started.", "success");
  };

  const handlePdf = async () => {
    if (!detail || exportingPdf) return;
    if (!detail.lecture.notes_markdown.trim()) {
      onToast("Generate notes before exporting a PDF.", "info");
      return;
    }
    if (!pdfNotesRef.current) return;
    setExportingPdf(true);
    try {
      await exportNotesPdf(
        detail.lecture.title,
        `${formatDate(detail.lecture.created_at)} · ${formatDuration(
          detail.lecture.duration_ms,
        )} · Lecture Notes AI`,
        pdfNotesRef.current,
      );
      onToast("PDF exported.", "success");
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "PDF export failed.",
        "error",
      );
    } finally {
      setExportingPdf(false);
    }
  };

  const handleCopyTranscript = async () => {
    if (!detail) return;
    const text = detail.segments
      .map((segment) => `[${formatTimestamp(segment.start_ms)}] ${segment.text}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      onToast("Transcript copied.", "success");
    } catch {
      onToast("Could not copy the transcript from this browser.", "error");
    }
  };

  if (loading) {
    return (
      <div className="lecture-view">
        <div className="center-state">
          <Loader2 size={22} className="spin" />
          <p>Opening lecture…</p>
        </div>
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="lecture-view">
        <div className="center-state error-state">
          <div className="center-state-icon">
            <AlertTriangle size={24} />
          </div>
          <h2>This lecture could not be opened</h2>
          <p>{loadError ?? "The lecture no longer exists."}</p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Back to library
          </button>
        </div>
      </div>
    );
  }

  const lecture = detail.lecture;
  const segments = detail.segments;
  const notes = lecture.notes_markdown;
  const needsFinish =
    lecture.status === "interrupted" || lecture.status === "processing";
  const safeAudioName =
    lecture.title
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 70) || "lecture";

  return (
    <div className="lecture-view">
      <div className="lecture-inner">
        <header className="lecture-header">
          <div className="lecture-heading">
            <div className="lecture-kicker">
              <span className={`status-pill tone-${statusTone(lecture.status)}`}>
                {lecture.status === "completed" ? (
                  <CheckCircle2 size={12} />
                ) : (
                  <span className="status-dot" />
                )}
                {statusLabel(lecture.status)}
              </span>
              <span>{formatDateTime(lecture.created_at)}</span>
              <span className="meta-dot" />
              <span>{formatDuration(lecture.duration_ms)}</span>
              <span className="meta-dot" />
              <span>
                {segments.length} {segments.length === 1 ? "passage" : "passages"}
              </span>
            </div>

            {titleEditing ? (
              <div className="title-edit-row">
                <input
                  className="title-input"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitTitle();
                    if (event.key === "Escape") {
                      setTitleDraft(lecture.title);
                      setTitleEditing(false);
                    }
                  }}
                  onBlur={() => void commitTitle()}
                  autoFocus
                  maxLength={240}
                  aria-label="Lecture title"
                />
                <button
                  type="button"
                  className="icon-button title-confirm"
                  onClick={() => void commitTitle()}
                  disabled={titleBusy}
                  aria-label="Save title"
                >
                  {titleBusy ? (
                    <Loader2 size={17} className="spin" />
                  ) : (
                    <Check size={17} />
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => {
                    setTitleDraft(lecture.title);
                    setTitleEditing(false);
                  }}
                  aria-label="Cancel renaming"
                >
                  <X size={17} />
                </button>
              </div>
            ) : (
              <h1 className="lecture-title">
                {lecture.title}
                <button
                  type="button"
                  className="title-pencil"
                  onClick={() => {
                    setTitleDraft(lecture.title);
                    setTitleEditing(true);
                  }}
                  aria-label="Rename lecture"
                  title="Rename lecture"
                >
                  <Pencil size={16} />
                </button>
              </h1>
            )}

            {lecture.last_error && (
              <div className="lecture-note-warning">
                <AlertTriangle size={14} />
                {lecture.last_error}
              </div>
            )}
          </div>

          <div className="lecture-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleMarkdown}
              title="Download Markdown with full transcript"
            >
              <Download size={16} />
              <span className="btn-label">Markdown</span>
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void handlePdf()}
              disabled={exportingPdf || !notes.trim()}
              title="Export notes as PDF"
            >
              {exportingPdf ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <FileDown size={16} />
              )}
              <span className="btn-label">
                {exportingPdf ? "Preparing…" : "PDF"}
              </span>
            </button>
            <div className="more-wrap">
              <button
                type="button"
                className="btn btn-ghost btn-icon-only"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label="More lecture actions"
                aria-expanded={menuOpen}
              >
                <MoreHorizontal size={18} />
              </button>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    className="menu-scrim"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="more-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmRegenerate(true);
                      }}
                      disabled={regenerating || segments.length === 0}
                    >
                      <RefreshCw size={15} />
                      {needsFinish ? "Finish notes" : "Regenerate notes"}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="danger-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmDelete(true);
                      }}
                    >
                      <Trash2 size={15} />
                      Delete lecture
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {regenerating && (
          <div className="processing-banner lecture-processing">
            <span className="processing-spinner">
              <Loader2 size={19} className="spin" />
            </span>
            <div>
              <strong>
                {needsFinish ? "Writing your final notes" : "Regenerating notes"}
              </strong>
              <p>
                The local model is reading the full transcript. This can take a
                minute on your Mac. Your transcript stays saved.
              </p>
            </div>
          </div>
        )}

        <div className="lecture-tabs">
          <button
            type="button"
            className={`tab-button ${tab === "notes" ? "active" : ""}`}
            onClick={() => setTab("notes")}
          >
            <Sparkles size={15} />
            Notes
          </button>
          <button
            type="button"
            className={`tab-button ${tab === "transcript" ? "active" : ""}`}
            onClick={() => setTab("transcript")}
          >
            <FileText size={15} />
            Transcript
            <span className="tab-count">{segments.length}</span>
          </button>
          <button
            type="button"
            className={`tab-button ${tab === "audio" ? "active" : ""}`}
            onClick={() => setTab("audio")}
          >
            <Headphones size={15} />
            Audio
          </button>

          <span className="tab-spacer" />

          {tab === "notes" && !editing && (
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={beginEditing}
            >
              <Pencil size={14} />
              Edit notes
            </button>
          )}
          {tab === "notes" && editing && (
            <>
              <span className={`save-state ${saveState}`}>
                {saveState === "saving" && <Loader2 size={13} className="spin" />}
                {saveState === "saved" && <CheckCircle2 size={13} />}
                {saveState === "error"
                  ? "Save failed"
                  : saveState === "saving"
                    ? "Saving…"
                    : saveState === "saved"
                      ? "Saved locally"
                      : "Autosaves locally"}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => void finishEditing()}
                disabled={saveState === "saving"}
              >
                <Check size={14} />
                Done
              </button>
            </>
          )}
          {tab === "transcript" && segments.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => void handleCopyTranscript()}
            >
              <Copy size={14} />
              Copy
            </button>
          )}
        </div>

        {tab === "notes" && (
          <section className="notes-surface">
            {editing ? (
              <>
                <div className="editor-bar">
                  <span>Markdown</span>
                  <span className="editor-hint">
                    Changes save automatically. Headings use # and ##.
                  </span>
                </div>
                <textarea
                  className="notes-editor"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck
                  aria-label="Edit lecture notes in Markdown"
                />
              </>
            ) : notes.trim() ? (
              <div className="lecture-notes">
                <Markdown hideTitle>{notes}</Markdown>
              </div>
            ) : (
              <div className="empty-state">
                <div className="panel-empty-icon accent">
                  <Sparkles size={22} />
                </div>
                <h2>No notes yet</h2>
                <p>
                  {segments.length > 0
                    ? "The transcript is saved. Generate study notes with the local language model whenever you are ready."
                    : "No speech was detected in this recording, so there is nothing to summarize yet."}
                </p>
                {segments.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setConfirmRegenerate(true)}
                  >
                    <Sparkles size={16} />
                    Generate notes locally
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {tab === "transcript" && (
          <section className="notes-surface transcript-surface">
            {segments.length === 0 ? (
              <div className="empty-state">
                <div className="panel-empty-icon">
                  <FileText size={22} />
                </div>
                <h2>No transcript</h2>
                <p>This recording did not capture any speech.</p>
              </div>
            ) : (
              <div className="lecture-transcript">
                {segments.map((segment) => (
                  <div className="lecture-transcript-line" key={segment.id}>
                    <span>{formatTimestamp(segment.start_ms)}</span>
                    <p>{segment.text}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "audio" && (
          <section className="notes-surface audio-surface">
            {lecture.audio_path ? (
              <div className="audio-card">
                <div className="audio-icon">
                  <Headphones size={26} />
                </div>
                <h2>Original recording</h2>
                <p>
                  16 kHz mono WAV · {formatDuration(lecture.duration_ms)} · stored
                  locally in your data folder
                </p>
                <audio controls preload="metadata" src={audioUrl(lecture.id)}>
                  Your browser cannot play this WAV recording.
                </audio>
                <a
                  className="btn btn-ghost"
                  href={audioUrl(lecture.id)}
                  download={`${safeAudioName}.wav`}
                >
                  <Download size={16} />
                  Download WAV
                </a>
              </div>
            ) : (
              <div className="empty-state">
                <div className="panel-empty-icon">
                  <Headphones size={22} />
                </div>
                <h2>No audio file</h2>
                <p>The recording for this lecture is not available.</p>
              </div>
            )}
          </section>
        )}

        <p className="lecture-footnote">
          <CheckCircle2 size={13} />
          Generated locally with {lecture.final_model ?? "Ollama"} · Notes updated{" "}
          {lecture.notes_updated_at
            ? formatDateTime(lecture.notes_updated_at)
            : "not yet"}
        </p>
      </div>

      <div className="pdf-source" aria-hidden="true">
        <div ref={pdfNotesRef}>
          <Markdown hideTitle>{notes}</Markdown>
        </div>
      </div>

      {confirmRegenerate && (
        <ConfirmDialog
          title={needsFinish ? "Finish this lecture?" : "Regenerate the notes?"}
          message={
            needsFinish
              ? "The app closed before final notes were written. Generate them now from the saved transcript? This can take a minute on your Mac."
              : "This replaces the current notes with a fresh set generated from the full transcript. Your transcript and audio are not changed."
          }
          confirmLabel={needsFinish ? "Finish notes" : "Regenerate"}
          busy={regenerating}
          onConfirm={() => void handleRegenerate()}
          onCancel={() => setConfirmRegenerate(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this lecture?"
          message={`"${lecture.title}" and its audio, transcript, and notes will be permanently deleted from this Mac.`}
          confirmLabel="Delete lecture"
          busy={deleting}
          destructive
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

    </div>
  );
}
