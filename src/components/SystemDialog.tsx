import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type { SystemStatus } from "../types";

interface SystemDialogProps {
  status: SystemStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

function StatusRow({
  ok,
  title,
  detail,
  icon,
}: {
  ok: boolean;
  title: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className="system-row">
      <div className={`system-icon ${ok ? "ok" : "warn"}`}>{icon}</div>
      <div className="system-row-copy">
        <div className="system-row-title">
          {title}
          <span className={`status-dot ${ok ? "ok" : "warn"}`} />
        </div>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function SystemDialog({ status, loading, onRefresh, onClose }: SystemDialogProps) {
  const whisperOk = status?.whisper.status === "ready";
  const ollamaOk = status?.ollama.status === "ready";

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-card system-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <div className="modal-kicker">
          <ShieldCheck size={15} /> Local models
        </div>
        <h2 id="system-title">Everything stays on this Mac</h2>
        <p className="modal-lede">
          Lecture Notes AI uses two open-weight models running locally. There are no cloud
          APIs, accounts, or keys.
        </p>

        <div className="system-list">
          <StatusRow
            ok={whisperOk}
            title="Speech recognition"
            detail={
              status
                ? `${status.whisper.message} Model: ${status.whisper.model}`
                : "Checking Whisper…"
            }
            icon={<Cpu size={18} />}
          />
          <StatusRow
            ok={ollamaOk}
            title="Note generation"
            detail={
              status
                ? `${status.ollama.message}`
                : "Checking Ollama…"
            }
            icon={<Sparkles size={18} />}
          />
        </div>

        {status && !whisperOk && (
          <div className="system-fix">
            <AlertTriangle size={16} />
            <div>
              <strong>Whisper is not ready</strong>
              <p>
                Run <code>npm run setup:whisper</code>, then restart <code>npm run dev</code>.
              </p>
            </div>
          </div>
        )}

        {status && !ollamaOk && (
          <div className="system-fix">
            <AlertTriangle size={16} />
            <div>
              <strong>
                {/no models/i.test(status.ollama.message)
                  ? "Ollama needs a model"
                  : "Ollama is offline"}
              </strong>
              <p>
                {/no models/i.test(status.ollama.message) ? (
                  <>
                    Download the local note model with{" "}
                    <code>ollama pull qwen2.5:3b</code>.
                  </>
                ) : (
                  <>
                    Start it with <code>ollama serve</code>. The installed model is
                    detected automatically.
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {status && ollamaOk && (
          <div className="model-pills">
            <span className="model-pill">
              <span>Live</span> {status.ollama.live_model}
            </span>
            <span className="model-pill">
              <span>Final</span> {status.ollama.final_model}
            </span>
          </div>
        )}

        <div className="system-footer">
          <span className="privacy-inline">
            <CheckCircle2 size={14} /> No audio or notes leave your computer
          </span>
          <button type="button" className="btn btn-ghost btn-small" onClick={onRefresh} disabled={loading}>
            {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
