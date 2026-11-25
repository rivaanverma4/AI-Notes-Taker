import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Mic,
  Pause,
  Play,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { RecordingState, TranscriptSegment } from "../types";
import { formatTimestamp, formatTimer } from "../lib/format";
import { Markdown } from "./Markdown";
import { Waveform } from "./Waveform";

interface RecordingViewProps {
  state: RecordingState;
  title: string;
  notes: string;
  segments: TranscriptSegment[];
  elapsedMs: number;
  level: number;
  error: string | null;
  warning: string | null;
  notesStatus: "generating" | "idle";
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onBack: () => void;
  onRetry: () => void;
  onOpenSystem: () => void;
  onDismissError: () => void;
  onDismissWarning: () => void;
}

type MobileTab = "transcript" | "notes";

function stateLabel(state: RecordingState): string {
  switch (state) {
    case "paused":
      return "Paused";
    case "processing":
      return "Finishing notes";
    case "completed":
      return "Saved";
    case "connecting":
      return "Connecting";
    default:
      return "Recording";
  }
}

export function RecordingView({
  state,
  title,
  notes,
  segments,
  elapsedMs,
  level,
  error,
  warning,
  notesStatus,
  onPause,
  onResume,
  onStop,
  onBack,
  onRetry,
  onOpenSystem,
  onDismissError,
  onDismissWarning,
}: RecordingViewProps) {
  const [mobileTab, setMobileTab] = useState<MobileTab>("transcript");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [segments.length]);

  const handleTranscriptScroll = () => {
    const element = transcriptRef.current;
    if (!element) return;
    stickToBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  };

  const connecting = state === "connecting" || (state === "idle" && !!error);
  if (connecting) {
    return (
      <div className="recording-view">
        <div className="recording-connecting">
          <div className="connect-card">
            <div className={`connect-orb ${error ? "has-error" : ""}`}>
              {error ? <AlertTriangle size={30} /> : <Mic size={30} />}
            </div>
            {error ? (
              <>
                <h1>Microphone not available</h1>
                <p className="connect-lede">{error}</p>
                <div className="connect-hints">
                  <span>Use Chrome, Edge, or Safari on localhost.</span>
                  <span>Click the lock icon in the address bar to allow the microphone.</span>
                  <span>Make sure no other app is holding the microphone.</span>
                </div>
                <div className="connect-actions">
                  <button type="button" className="btn btn-primary" onClick={onRetry}>
                    <Mic size={16} />
                    Try again
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={onBack}>
                    <ArrowLeft size={16} />
                    Back to library
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={onOpenSystem}>
                    <Settings2 size={15} />
                    Check local setup
                  </button>
                </div>
              </>
            ) : (
              <>
                <h1>Connecting your microphone…</h1>
                <p className="connect-lede">
                  Allow microphone access when your browser asks. Audio is sent
                  only to the local server on this Mac.
                </p>
                <div className="connect-loader">
                  <Loader2 size={18} className="spin" />
                  Preparing local transcription
                </div>
                <button type="button" className="btn btn-quiet" onClick={onBack}>
                  <ArrowLeft size={15} />
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const recording = state === "recording";
  const processing = state === "processing";

  return (
    <div className="recording-view">
      <header className="recording-header">
        <div className="rec-heading">
          <div className="rec-kicker">
            <span className={`live-pill ${recording ? "is-live" : ""} ${state}`}>
              {processing ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <span className="live-dot" />
              )}
              {stateLabel(state)}
            </span>
            <span className="rec-saved">
              <CheckCircle2 size={13} />
              Saved locally as you go
            </span>
          </div>
          <h1>{title || "New lecture"}</h1>
          <p className="rec-sub">
            {processing
              ? "Transcribing the final moments and composing your study notes."
              : state === "paused"
                ? "Recording is paused. Your transcript and notes are safe."
                : "Listening now — notes update automatically as the lecture unfolds."}
          </p>
        </div>
        <div className="rec-timer" aria-label={`Elapsed time ${formatTimer(elapsedMs)}`}>
          {formatTimer(elapsedMs)}
        </div>
      </header>

      <div className="recording-dock">
        <Waveform
          level={level}
          active={recording}
          paused={state === "paused" || processing}
          bars={34}
        />
        <div className="rec-controls">
          {state === "paused" ? (
            <button
              type="button"
              className="rec-control rec-pause"
              onClick={onResume}
              aria-label="Resume recording"
              title="Resume recording"
            >
              <Play size={19} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="rec-control rec-pause"
              onClick={onPause}
              disabled={!recording}
              aria-label="Pause recording"
              title="Pause recording"
            >
              <Pause size={19} fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            className="rec-control rec-stop"
            onClick={onStop}
            disabled={processing}
            aria-label="Stop recording and generate final notes"
            title="Stop and generate final notes"
          >
            <Square size={17} fill="currentColor" />
          </button>
        </div>
      </div>

      {error && (
        <div className="inline-banner error">
          <AlertTriangle size={17} />
          <div className="banner-copy">
            <strong>Something interrupted the recording</strong>
            <p>{error}</p>
          </div>
          <button
            type="button"
            className="banner-close"
            onClick={onDismissError}
            aria-label="Dismiss error"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {warning && (
        <div className="inline-banner warn">
          <AlertTriangle size={17} />
          <div className="banner-copy">
            <strong>Notes are catching up</strong>
            <p>{warning}</p>
          </div>
          <button
            type="button"
            className="banner-close"
            onClick={onDismissWarning}
            aria-label="Dismiss warning"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {processing && (
        <div className="processing-banner">
          <span className="processing-spinner">
            <Loader2 size={19} className="spin" />
          </span>
          <div>
            <strong>Finishing transcription and writing final notes</strong>
            <p>
              This can take a minute with the larger local model. Everything is
              already saved — you can leave this screen once it completes.
            </p>
          </div>
        </div>
      )}

      <div className="mobile-tabs recording-mobile-tabs">
        <button
          type="button"
          className={`mobile-tab ${mobileTab === "transcript" ? "active" : ""}`}
          onClick={() => setMobileTab("transcript")}
        >
          <FileText size={15} />
          Transcript
          <span>{segments.length}</span>
        </button>
        <button
          type="button"
          className={`mobile-tab ${mobileTab === "notes" ? "active" : ""}`}
          onClick={() => setMobileTab("notes")}
        >
          <Sparkles size={15} />
          Live notes
          {notesStatus === "generating" && <Loader2 size={13} className="spin" />}
        </button>
      </div>

      <div className="recording-body">
        <section
          className={`panel transcript-panel ${
            mobileTab === "transcript" ? "mobile-active" : ""
          }`}
        >
          <header className="panel-head">
            <div className="panel-title">
              <FileText size={16} />
              <h2>Transcript</h2>
            </div>
            <span className="panel-meta">
              {segments.length} {segments.length === 1 ? "passage" : "passages"}
            </span>
          </header>
          <div
            className="transcript-scroll"
            ref={transcriptRef}
            onScroll={handleTranscriptScroll}
          >
            {segments.length === 0 ? (
              <div className="panel-empty">
                <div className="panel-empty-icon">
                  <Mic size={20} />
                </div>
                <h3>Waiting for the first words</h3>
                <p>
                  Speak normally. The local Whisper model turns each pause into a
                  timestamped transcript passage.
                </p>
              </div>
            ) : (
              segments.map((segment) => (
                <div className="transcript-line" key={segment.id}>
                  <span className="transcript-time">
                    {formatTimestamp(segment.start_ms)}
                  </span>
                  <p>{segment.text}</p>
                </div>
              ))
            )}
            {recording && (
              <div className="listening-indicator">
                <span />
                <span />
                <span />
                Listening
              </div>
            )}
          </div>
        </section>

        <section
          className={`panel notes-panel ${mobileTab === "notes" ? "mobile-active" : ""}`}
        >
          <header className="panel-head">
            <div className="panel-title">
              <Sparkles size={16} />
              <h2>Live notes</h2>
            </div>
            {notesStatus === "generating" ? (
              <span className="generating-pill">
                <Loader2 size={12} className="spin" />
                Writing notes
              </span>
            ) : (
              <span className="panel-meta">Local model</span>
            )}
          </header>
          <div className="notes-scroll">
            {notes ? (
              <Markdown hideTitle>{notes}</Markdown>
            ) : (
              <div className="panel-empty">
                <div className="panel-empty-icon accent">
                  <Sparkles size={20} />
                </div>
                <h3>Notes will take shape here</h3>
                <p>
                  After the first minute of speech, the local language model
                  starts organizing definitions, topics, and examples.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
