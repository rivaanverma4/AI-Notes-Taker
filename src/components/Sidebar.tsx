import {
  AlertCircle,
  Clock3,
  FileText,
  Loader2,
  Mic,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import type { LectureSummary, SystemStatus } from "../types";
import {
  formatDuration,
  formatShortDate,
  groupLectures,
  statusLabel,
} from "../lib/format";

interface SidebarProps {
  lectures: LectureSummary[];
  selectedId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onHome: () => void;
  onSystem: () => void;
  system: SystemStatus | null;
  recordingBusy: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

function StatusBadge({ lecture }: { lecture: LectureSummary }) {
  if (lecture.status === "completed") return null;
  const icon =
    lecture.status === "processing" ? (
      <Loader2 size={11} className="spin" />
    ) : lecture.status === "recording" ? (
      <span className="mini-recording-dot" />
    ) : lecture.status === "interrupted" ? (
      <AlertCircle size={11} />
    ) : (
      <Clock3 size={11} />
    );
  return (
    <span className={`lecture-status status-${lecture.status}`}>
      {icon}
      {statusLabel(lecture.status)}
    </span>
  );
}

export function Sidebar({
  lectures,
  selectedId,
  search,
  onSearch,
  onNew,
  onOpen,
  onHome,
  onSystem,
  system,
  recordingBusy,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const groups = groupLectures(lectures);
  const systemOk = system?.whisper.status === "ready" && system?.ollama.status === "ready";

  return (
    <>
      <div
        className={`sidebar-backdrop ${mobileOpen ? "visible" : ""}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-top">
          <button type="button" className="brand" onClick={onHome} aria-label="Lecture Notes AI home">
            <span className="brand-mark">
              <Mic size={19} strokeWidth={2.1} />
            </span>
            <span className="brand-copy">
              <strong>Lecture Notes AI</strong>
              <span>Local study assistant</span>
            </span>
          </button>
          <button
            type="button"
            className="icon-button sidebar-mobile-close"
            onClick={onMobileClose}
            aria-label="Close sidebar"
          >
            <X size={19} />
          </button>
        </div>

        <button
          type="button"
          className="new-lecture-button"
          onClick={onNew}
          disabled={recordingBusy}
          title={recordingBusy ? "Finish the current recording first" : "Start a new lecture"}
        >
          <Plus size={17} />
          New lecture
        </button>

        <label className="search-field">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search lectures"
            aria-label="Search lectures"
          />
          {search && (
            <button
              type="button"
              className="search-clear"
              onClick={() => onSearch("")}
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </label>

        <div className="library-heading">
          <span>Library</span>
          <span className="library-count">{lectures.length}</span>
        </div>

        <div className="lecture-list">
          {groups.length === 0 && (
            <div className="sidebar-empty">
              <FileText size={22} />
              <p>{search ? "No matching lectures." : "Your saved lectures will appear here."}</p>
            </div>
          )}
          {groups.map((group) => (
            <div key={group.label} className="lecture-group">
              <div className="lecture-group-label">{group.label}</div>
              {group.lectures.map((lecture) => (
                <button
                  key={lecture.id}
                  type="button"
                  className={`lecture-item ${selectedId === lecture.id ? "selected" : ""}`}
                  onClick={() => onOpen(lecture.id)}
                >
                  <span className="lecture-item-top">
                    <span className="lecture-item-title">{lecture.title}</span>
                    <StatusBadge lecture={lecture} />
                  </span>
                  <span className="lecture-item-meta">
                    <span>{formatShortDate(lecture.created_at)}</span>
                    <span className="meta-dot" />
                    <span>{formatDuration(lecture.duration_ms)}</span>
                    {lecture.segment_count > 0 && (
                      <>
                        <span className="meta-dot" />
                        <span>{lecture.segment_count} lines</span>
                      </>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button type="button" className="system-button" onClick={onSystem}>
            <span className={`status-dot ${systemOk ? "ok" : "warn"}`} />
            <span className="system-button-copy">
              <strong>{systemOk ? "Local models ready" : "Check local setup"}</strong>
              <span>
                <ShieldCheck size={12} /> No cloud · no API keys
              </span>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
    </>
  );
}
