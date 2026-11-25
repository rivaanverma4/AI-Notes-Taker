import { useCallback, useEffect, useState } from "react";
import { Loader2, Menu, Mic, ShieldCheck } from "lucide-react";
import type { Lecture, LectureSummary, SystemStatus } from "./types";
import { getLectures, getSystemStatus, prepareServices } from "./lib/api";
import { useRecorder } from "./hooks/useRecorder";
import { Sidebar } from "./components/Sidebar";
import { HomeView } from "./components/HomeView";
import { RecordingView } from "./components/RecordingView";
import { LectureView } from "./components/LectureView";
import { SystemDialog } from "./components/SystemDialog";
import { Toast, type ToastKind } from "./components/Toast";

type View = "home" | "recording" | "lecture";

interface ToastState {
  id: number;
  message: string;
  kind: ToastKind;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lectures, setLectures] = useState<LectureSummary[]>([]);
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [preparing, setPreparing] = useState(false);

  const refreshLibrary = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  const closeToast = useCallback(() => setToast(null), []);

  const notify = useCallback(
    (message: string, kind: ToastKind = "info") => {
      setToast({ id: Date.now() + Math.random(), message, kind });
    },
    [],
  );

  const handleCompleted = useCallback(
    (lecture: Lecture) => {
      setSelectedId(lecture.id);
      setView("lecture");
      setRefreshKey((key) => key + 1);
      notify("Your final notes are ready.", "success");
    },
    [notify],
  );

  const recorder = useRecorder({ onCompleted: handleCompleted });

  const recordingBusy = [
    "connecting",
    "recording",
    "paused",
    "processing",
  ].includes(recorder.state);

  const systemOk =
    system?.whisper.status === "ready" && system?.ollama.status === "ready";

  const loadSystem = useCallback(async () => {
    setSystemLoading(true);
    try {
      const status = await getSystemStatus();
      setSystem(status);
    } catch {
      setSystem(null);
    } finally {
      setSystemLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSystem();
    // Poll quickly while something is starting, then settle into a slow
    // heartbeat that also notices a service dying in the background.
    const timer = window.setInterval(
      () => void loadSystem(),
      systemOk ? 30_000 : 4_000,
    );
    return () => window.clearInterval(timer);
  }, [loadSystem, systemOk]);

  useEffect(() => {
    let cancelled = false;
    setLibraryLoading(true);
    const timer = window.setTimeout(
      () => {
        void (async () => {
          try {
            const data = await getLectures(search);
            if (!cancelled) setLectures(data);
          } catch (error) {
            if (!cancelled) {
              notify(
                error instanceof Error
                  ? `Could not load the lecture library: ${error.message}`
                  : "Could not load the lecture library.",
                "error",
              );
            }
          } finally {
            if (!cancelled) setLibraryLoading(false);
          }
        })();
      },
      search.trim() ? 220 : 0,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, refreshKey, notify]);

  const handleStart = async () => {
    if (recordingBusy || preparing) {
      notify("Finish or stop the current recording first.", "info");
      return;
    }
    setPreparing(true);
    setMobileOpen(false);
    try {
      const prepared = await prepareServices();
      setSystem(prepared);
      if (!prepared.ready) {
        notify(
          prepared.whisper.message ||
            "The local transcription service is still starting. Please try again in a moment.",
          "error",
        );
        return;
      }
      recorder.reset();
      setSelectedId(null);
      setView("recording");
      if (prepared.ollama.status !== "ready") {
        notify(
          "Transcription is ready. Notes will begin as soon as Ollama finishes starting.",
          "info",
        );
      }
      await recorder.startRecording();
    } catch (error) {
      notify(
        error instanceof Error
          ? `Could not start the local services: ${error.message}`
          : "Could not start the local services.",
        "error",
      );
    } finally {
      setPreparing(false);
    }
  };

  const handleOpen = (id: string) => {
    if (recordingBusy) {
      notify("Finish or stop the current recording before opening another lecture.", "info");
      return;
    }
    setSelectedId(id);
    setView("lecture");
    setMobileOpen(false);
  };

  const handleHome = () => {
    if (recordingBusy) {
      notify("Finish or stop the current recording before leaving this screen.", "info");
      return;
    }
    setView("home");
    setSelectedId(null);
    setMobileOpen(false);
  };

  const handleBackToLibrary = () => {
    recorder.reset();
    setView("home");
    setSelectedId(null);
  };

  const openSystem = () => {
    setSystemOpen(true);
    void loadSystem();
  };

  return (
    <div className="app-shell">
      <Sidebar
        lectures={lectures}
        selectedId={view === "lecture" ? selectedId : null}
        search={search}
        onSearch={setSearch}
        onNew={() => void handleStart()}
        onOpen={handleOpen}
        onHome={handleHome}
        onSystem={openSystem}
        system={system}
        recordingBusy={recordingBusy}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className="app-main">
        <header className="mobile-bar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open lecture library"
          >
            <Menu size={20} />
          </button>
          <span className="mobile-brand">
            <span className="mobile-brand-mark">
              <Mic size={15} />
            </span>
            Lecture Notes AI
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={openSystem}
            aria-label="Local model status"
          >
            <span className={`status-dot ${systemOk ? "ok" : "warn"}`} />
            <ShieldCheck size={18} />
          </button>
        </header>

        <main className="app-content">
          {view === "home" && (
            <HomeView
              lectures={lectures}
              system={system}
              loading={libraryLoading}
              onStart={() => void handleStart()}
              onOpen={handleOpen}
              onSystem={openSystem}
            />
          )}

          {view === "recording" && (
            <RecordingView
              state={recorder.state}
              title={recorder.title}
              notes={recorder.notes}
              segments={recorder.segments}
              elapsedMs={recorder.elapsedMs}
              level={recorder.level}
              error={recorder.error}
              warning={recorder.warning}
              notesStatus={recorder.notesStatus}
              onPause={recorder.pause}
              onResume={recorder.resume}
              onStop={recorder.stop}
              onBack={handleBackToLibrary}
              onRetry={() => void recorder.startRecording()}
              onOpenSystem={openSystem}
              onDismissError={recorder.clearError}
              onDismissWarning={recorder.clearWarning}
            />
          )}

          {view === "lecture" && selectedId && (
            <LectureView
              key={selectedId}
              lectureId={selectedId}
              onDeleted={() => {
                setSelectedId(null);
                setView("home");
                refreshLibrary();
                notify("Lecture deleted.", "success");
              }}
              onClose={handleHome}
              onChanged={refreshLibrary}
              onToast={notify}
            />
          )}
        </main>
      </div>

      {systemOpen && (
        <SystemDialog
          status={system}
          loading={systemLoading}
          onRefresh={() => void loadSystem()}
          onClose={() => setSystemOpen(false)}
        />
      )}

      {preparing && (
        <div className="prepare-overlay" role="status" aria-live="polite">
          <div className="prepare-card">
            <div className="prepare-orb">
              <Loader2 size={26} className="spin" />
            </div>
            <h2>Waking up the local models…</h2>
            <p>
              Whisper and Ollama run on this Mac. The first start can take a few
              seconds, then everything stays local and offline.
            </p>
            <div className="prepare-track" aria-hidden="true">
              <span />
            </div>
          </div>
        </div>
      )}

      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          kind={toast.kind}
          onClose={closeToast}
        />
      )}
    </div>
  );
}
