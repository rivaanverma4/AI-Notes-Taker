import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Cpu,
  FileText,
  Loader2,
  Mic,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { LectureSummary, SystemStatus } from "../types";
import {
  formatDuration,
  formatShortDate,
  relativeUpdated,
  statusLabel,
} from "../lib/format";

interface HomeViewProps {
  lectures: LectureSummary[];
  system: SystemStatus | null;
  loading: boolean;
  onStart: () => void;
  onOpen: (id: string) => void;
  onSystem: () => void;
}

const features = [
  {
    icon: ShieldCheck,
    title: "Private by design",
    body: "Audio, transcripts, and notes stay in a local folder on this Mac. No accounts, uploads, or API keys.",
  },
  {
    icon: Sparkles,
    title: "Notes that keep up",
    body: "Whisper transcribes as you speak while a local language model organizes the lecture into live notes.",
  },
  {
    icon: FileText,
    title: "Ready to study",
    body: "Reopen any lecture, search every transcript, edit the notes, and export clean Markdown or PDF.",
  },
];

function SetupBanner({
  system,
  onSystem,
}: {
  system: SystemStatus;
  onSystem: () => void;
}) {
  const whisperOk = system.whisper.status === "ready";
  const ollamaOk = system.ollama.status === "ready";
  const starting =
    (!whisperOk &&
      (system.whisper.status === "starting" ||
        /starting|restarting|loading/i.test(system.whisper.message))) ||
    (!ollamaOk && /starting/i.test(system.ollama.message));
  if (starting) {
    return (
      <div className="setup-banner starting">
        <div className="setup-icon">
          <Loader2 size={19} className="spin" />
        </div>
        <div className="setup-copy">
          <strong>Starting the local models…</strong>
          <p>
            Whisper and Ollama live on this Mac. This takes a few seconds the
            first time and after a restart — no internet or account needed.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-small" onClick={onSystem}>
          View status
          <ArrowRight size={15} />
        </button>
      </div>
    );
  }
  return (
    <div className="setup-banner">
      <div className="setup-icon">
        <AlertTriangle size={19} />
      </div>
      <div className="setup-copy">
        <strong>One local piece needs attention</strong>
        <p>
          {!whisperOk && system.whisper.message}{" "}
          {!ollamaOk && system.ollama.message}
        </p>
        <div className="setup-steps">
          {!whisperOk && (
            <code>npm run setup:whisper</code>
          )}
          {!ollamaOk &&
            (/no models/i.test(system.ollama.message) ? (
              <code>ollama pull qwen2.5:3b</code>
            ) : (
              <code>ollama serve</code>
            ))}
        </div>
      </div>
      <button type="button" className="btn btn-ghost btn-small" onClick={onSystem}>
        Check setup
        <ArrowRight size={15} />
      </button>
    </div>
  );
}

export function HomeView({
  lectures,
  system,
  loading,
  onStart,
  onOpen,
  onSystem,
}: HomeViewProps) {
  const whisperOk = system?.whisper.status === "ready";
  const ollamaOk = system?.ollama.status === "ready";
  const allReady = whisperOk && ollamaOk;
  const recent = lectures.slice(0, 6);

  return (
    <div className="home-view">
      <div className="home-inner">
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="eyebrow-dot" />
              Local-first study notes
            </span>
            <h1>Turn any lecture into notes you can actually study.</h1>
            <p className="hero-lede">
              Record your class, watch the transcript appear, and get structured
              notes written by a model running on your Mac. Nothing is uploaded.
            </p>
            <div className="hero-actions">
              <button type="button" className="btn btn-primary btn-large" onClick={onStart}>
                <Mic size={18} />
                Start recording
              </button>
              <button type="button" className="btn btn-ghost btn-large" onClick={onSystem}>
                <ShieldCheck size={17} />
                Local setup
              </button>
            </div>
            <div className="trust-row">
              <span>
                <CheckCircle2 size={14} /> Works offline
              </span>
              <span>
                <CheckCircle2 size={14} /> No API keys
              </span>
              <span>
                <CheckCircle2 size={14} /> Open-weight models
              </span>
            </div>
          </div>

          <div className="orb-stage">
            <button
              type="button"
              className="record-orb"
              onClick={onStart}
              aria-label="Start a new lecture recording"
            >
              <span className="orb-ring ring-one" />
              <span className="orb-ring ring-two" />
              <span className="orb-ring ring-three" />
              <span className="orb-core">
                <Mic size={38} strokeWidth={1.9} />
                <span className="orb-label">Record</span>
              </span>
            </button>
            <p className="orb-caption">Tap to record · pause anytime</p>
          </div>
        </section>

        {system === null ? (
          <div className="model-strip checking">
            <Loader2 size={15} className="spin" />
            Checking the local speech and note models…
          </div>
        ) : allReady ? (
          <div className="model-strip">
            <span className="model-chip">
              <span className="status-dot ok" />
              <Cpu size={15} />
              <span>
                <strong>Speech</strong> {system.whisper.model}
              </span>
            </span>
            <span className="model-chip">
              <span className="status-dot ok" />
              <Sparkles size={15} />
              <span>
                <strong>Notes</strong> {system.ollama.live_model}
              </span>
            </span>
            <span className="model-strip-note">
              <ShieldCheck size={14} /> Runs entirely on this Mac
            </span>
          </div>
        ) : (
          <SetupBanner system={system} onSystem={onSystem} />
        )}

        <section className="home-section">
          <div className="section-heading">
            <div>
              <h2>Recent lectures</h2>
              <p>Pick up where you left off, or search the whole library.</p>
            </div>
            <span className="section-count">
              {lectures.length} {lectures.length === 1 ? "lecture" : "lectures"}
            </span>
          </div>

          {loading && lectures.length === 0 ? (
            <div className="lecture-grid">
              {[0, 1, 2].map((item) => (
                <div className="lecture-card skeleton-card" key={item}>
                  <span className="skeleton-line wide" />
                  <span className="skeleton-line" />
                  <span className="skeleton-line short" />
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="home-empty">
              <div className="home-empty-icon">
                <Mic size={22} />
              </div>
              <div>
                <h3>Your first lecture starts here</h3>
                <p>
                  Press record, allow microphone access, and speak normally.
                  Transcript lines and notes will appear as the lecture unfolds.
                </p>
              </div>
              <button type="button" className="btn btn-primary" onClick={onStart}>
                <Mic size={16} />
                Record a lecture
              </button>
            </div>
          ) : (
            <div className="lecture-grid">
              {recent.map((lecture) => (
                <button
                  type="button"
                  className="lecture-card"
                  key={lecture.id}
                  onClick={() => onOpen(lecture.id)}
                >
                  <span className="lecture-card-top">
                    <span className={`status-pill status-${lecture.status}`}>
                      {statusLabel(lecture.status)}
                    </span>
                    <ArrowRight size={16} className="lecture-card-arrow" />
                  </span>
                  <h3>{lecture.title}</h3>
                  <span className="lecture-card-meta">
                    <span>{formatShortDate(lecture.created_at)}</span>
                    <span className="meta-dot" />
                    <span>{formatDuration(lecture.duration_ms)}</span>
                    {lecture.segment_count > 0 && (
                      <>
                        <span className="meta-dot" />
                        <span>{lecture.segment_count} passages</span>
                      </>
                    )}
                  </span>
                  <span className="lecture-card-foot">
                    <Clock3 size={13} />
                    {relativeUpdated(lecture.notes_updated_at)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.title}>
              <div className="feature-icon">
                <feature.icon size={19} />
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </section>

        <footer className="home-footer">
          <ShieldCheck size={14} />
          Lecture Notes AI uses whisper.cpp and Ollama on your machine. No cloud
          services are contacted.
        </footer>
      </div>
    </div>
  );
}
