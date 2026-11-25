import { useEffect, useRef, useState } from "react";
import type {
  Lecture,
  RecordingState,
  ServerEvent,
  TranscriptSegment,
} from "../types";

interface RecorderOptions {
  onCompleted?: (lecture: Lecture) => void;
}

function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function micErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Microphone access was denied. Click the lock icon in your browser's address bar, allow the microphone, and try again.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone was found. Connect a microphone and try again.";
      case "NotReadableError":
      case "TrackStartError":
        return "The microphone is in use by another application. Close the other app and try again.";
      case "SecurityError":
        return "Microphone access requires localhost or HTTPS.";
      default:
        return `Could not access the microphone: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : "Could not access the microphone.";
}

export function useRecorder({ onCompleted }: RecorderOptions = {}) {
  const [state, setState] = useState<RecordingState>("idle");
  const [lectureId, setLectureId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notesStatus, setNotesStatus] = useState<"generating" | "idle">("idle");

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const muteRef = useRef<GainNode | null>(null);
  const streamingRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const resumeIntentRef = useRef(false);
  const stateRef = useRef<RecordingState>("idle");
  const lectureIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const accumulatedRef = useRef(0);
  const serverDurationRef = useRef(0);
  const onCompletedRef = useRef(onCompleted);
  const connectRejectRef = useRef<((error: Error) => void) | null>(null);

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const setRecState = (next: RecordingState) => {
    stateRef.current = next;
    setState(next);
  };

  const setLecture = (id: string | null) => {
    lectureIdRef.current = id;
    setLectureId(id);
  };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const beginTimer = (baseMs: number) => {
    clearTimer();
    accumulatedRef.current = Math.max(0, baseMs);
    startedAtRef.current = Date.now();
    setElapsedMs(accumulatedRef.current);
    timerRef.current = window.setInterval(() => {
      if (startedAtRef.current === null) return;
      setElapsedMs(accumulatedRef.current + (Date.now() - startedAtRef.current));
    }, 250);
  };

  const freezeTimer = () => {
    if (startedAtRef.current !== null) {
      accumulatedRef.current += Date.now() - startedAtRef.current;
      startedAtRef.current = null;
    }
    clearTimer();
    setElapsedMs(accumulatedRef.current);
  };

  const cleanupAudio = () => {
    streamingRef.current = false;
    setLevel(0);
    try {
      workletRef.current?.port.postMessage("flush");
    } catch {
      // Ignore.
    }
    try {
      sourceRef.current?.disconnect();
      filterRef.current?.disconnect();
      workletRef.current?.disconnect();
      muteRef.current?.disconnect();
    } catch {
      // Ignore.
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
    streamRef.current = null;
    sourceRef.current = null;
    filterRef.current = null;
    workletRef.current = null;
    muteRef.current = null;
  };

  const closeSocket = (intentional = true) => {
    if (intentional) intentionalCloseRef.current = true;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= 1) {
      try {
        ws.close();
      } catch {
        // Ignore.
      }
    }
  };

  const handleEvent = (event: ServerEvent) => {
    switch (event.type) {
      case "started": {
        setLecture(event.lecture.id);
        setTitle(event.lecture.title);
        setNotes(event.lecture.notes_markdown);
        serverDurationRef.current = event.lecture.duration_ms;
        setRecState("recording");
        streamingRef.current = true;
        beginTimer(0);
        break;
      }
      case "snapshot": {
        setLecture(event.lecture.id);
        setTitle(event.lecture.title);
        setNotes(event.lecture.notes_markdown);
        setSegments(event.segments);
        serverDurationRef.current = event.lecture.duration_ms;
        accumulatedRef.current = event.lecture.duration_ms;
        setElapsedMs(event.lecture.duration_ms);

        if (resumeIntentRef.current) {
          resumeIntentRef.current = false;
          if (event.lecture.status === "paused") {
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resume" }));
            }
          }
        }

        if (event.lecture.status === "paused") {
          freezeTimer();
          setRecState("paused");
          streamingRef.current = false;
        } else if (event.lecture.status === "recording") {
          setRecState("recording");
          streamingRef.current = true;
          if (startedAtRef.current === null) {
            beginTimer(event.lecture.duration_ms);
          }
        } else if (event.lecture.status === "processing") {
          freezeTimer();
          setRecState("processing");
          streamingRef.current = false;
        } else if (event.lecture.status === "completed") {
          freezeTimer();
          setRecState("completed");
          streamingRef.current = false;
        } else if (event.lecture.status === "interrupted") {
          freezeTimer();
          setRecState("paused");
          streamingRef.current = false;
        }
        break;
      }
      case "transcript": {
        setSegments((current) =>
          current.some((segment) => segment.id === event.segment.id)
            ? current
            : [...current, event.segment],
        );
        break;
      }
      case "notes": {
        setNotes(event.notes_markdown);
        setTitle(event.title);
        break;
      }
      case "notes_status": {
        setNotesStatus(event.status);
        break;
      }
      case "status": {
        serverDurationRef.current = event.duration_ms;
        if (event.status === "recording") {
          if (stateRef.current !== "recording") {
            beginTimer(event.duration_ms || accumulatedRef.current);
          }
          setRecState("recording");
          streamingRef.current = true;
        } else if (event.status === "paused") {
          freezeTimer();
          setElapsedMs(event.duration_ms);
          accumulatedRef.current = event.duration_ms;
          setRecState("paused");
          streamingRef.current = false;
        } else if (event.status === "processing") {
          freezeTimer();
          setRecState("processing");
          streamingRef.current = false;
        } else if (event.status === "completed") {
          freezeTimer();
          setRecState("completed");
          streamingRef.current = false;
        } else if (event.status === "interrupted") {
          freezeTimer();
          setRecState("paused");
          streamingRef.current = false;
        }
        break;
      }
      case "warning": {
        setWarning(event.message);
        break;
      }
      case "completed": {
        setLecture(event.lecture.id);
        setTitle(event.lecture.title);
        setNotes(event.lecture.notes_markdown);
        freezeTimer();
        setElapsedMs(event.lecture.duration_ms);
        accumulatedRef.current = event.lecture.duration_ms;
        setRecState("completed");
        setNotesStatus("idle");
        cleanupAudio();
        closeSocket(true);
        onCompletedRef.current?.(event.lecture);
        break;
      }
      case "error": {
        setError(event.message);
        if (stateRef.current === "connecting") {
          cleanupAudio();
          closeSocket(true);
          setRecState("idle");
        } else if (stateRef.current === "recording") {
          streamingRef.current = false;
          freezeTimer();
          setRecState("paused");
        }
        break;
      }
    }
  };

  const attachSocket = (path: string): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(path));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      let opened = false;
      connectRejectRef.current = reject;

      ws.onopen = () => {
        opened = true;
        connectRejectRef.current = null;
        resolve(ws);
      };
      ws.onmessage = (message) => {
        try {
          handleEvent(JSON.parse(message.data as string) as ServerEvent);
        } catch {
          setError("Received an invalid message from the local server.");
        }
      };
      ws.onerror = () => {
        if (!opened) {
          connectRejectRef.current = null;
          reject(new Error("Could not connect to the local server."));
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (intentionalCloseRef.current) {
          intentionalCloseRef.current = false;
          return;
        }
        const current = stateRef.current;
        if (current === "recording") {
          cleanupAudio();
          freezeTimer();
          setRecState("paused");
          setError(
            "The connection to the local server was lost. Your transcript is saved. Reopen the lecture to resume or finish it.",
          );
        } else if (current === "processing") {
          setWarning(
            "The connection closed while finalizing. Your lecture and transcript are saved in the library.",
          );
        } else if (current === "connecting") {
          cleanupAudio();
          setRecState("idle");
          setError("Could not connect to the local server.");
        }
      };
    });
  };

  const setupAudio = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "This browser does not support microphone capture. Use Chrome, Edge, or Safari on localhost.",
      );
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: 16000 });
    } catch {
      context = new AudioContext();
    }
    contextRef.current = context;
    await context.audioWorklet.addModule("/audio-worklet.js");

    const source = context.createMediaStreamSource(stream);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 7200;
    filter.Q.value = 0.707;
    const worklet = new AudioWorkletNode(context, "pcm-capture", {
      processorOptions: { targetRate: 16000 },
    });
    const mute = context.createGain();
    mute.gain.value = 0;

    source.connect(filter);
    filter.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);

    worklet.port.onmessage = (message: MessageEvent<ArrayBuffer>) => {
      if (!streamingRef.current) return;
      const buffer = message.data;
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(buffer);
      } catch {
        return;
      }
      const pcm = new Int16Array(buffer);
      let sum = 0;
      for (let index = 0; index < pcm.length; index += 1) {
        const value = pcm[index] / 32768;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / Math.max(1, pcm.length));
      setLevel(Math.min(1, rms * 7));
    };

    await context.resume();
    sourceRef.current = source;
    filterRef.current = filter;
    workletRef.current = worklet;
    muteRef.current = mute;
  };

  const startRecording = async (): Promise<boolean> => {
    if (stateRef.current === "recording" || stateRef.current === "paused") {
      return false;
    }
    setError(null);
    setWarning(null);
    setTitle("");
    setNotes("");
    setSegments([]);
    setElapsedMs(0);
    setNotesStatus("idle");
    setLecture(null);
    accumulatedRef.current = 0;
    startedAtRef.current = null;
    setRecState("connecting");

    try {
      await setupAudio();
      const ws = await attachSocket("/ws/record");
      ws.send(JSON.stringify({ type: "start" }));
      return true;
    } catch (caught) {
      cleanupAudio();
      closeSocket(true);
      setRecState("idle");
      setError(micErrorMessage(caught));
      return false;
    }
  };

  const resumeLecture = async (id: string): Promise<boolean> => {
    if (stateRef.current === "recording" || stateRef.current === "paused") {
      return false;
    }
    setError(null);
    setWarning(null);
    setNotesStatus("idle");
    setLecture(id);
    setRecState("connecting");
    resumeIntentRef.current = true;

    try {
      await setupAudio();
      await attachSocket(`/ws/record/${encodeURIComponent(id)}`);
      return true;
    } catch (caught) {
      resumeIntentRef.current = false;
      cleanupAudio();
      closeSocket(true);
      setRecState("idle");
      setError(micErrorMessage(caught));
      return false;
    }
  };

  const pause = () => {
    if (stateRef.current !== "recording") return;
    streamingRef.current = false;
    freezeTimer();
    setRecState("paused");
    setLevel(0);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "pause" }));
    }
  };

  const resume = () => {
    if (stateRef.current !== "paused") return;
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      setError("The local server connection is closed. Reopen the lecture to resume.");
      return;
    }
    ws.send(JSON.stringify({ type: "resume" }));
    setRecState("recording");
    streamingRef.current = true;
    beginTimer(accumulatedRef.current);
  };

  const stop = () => {
    if (stateRef.current !== "recording" && stateRef.current !== "paused") return;
    streamingRef.current = false;
    freezeTimer();
    setRecState("processing");
    setLevel(0);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
    cleanupAudio();
  };

  const reset = () => {
    cleanupAudio();
    freezeTimer();
    closeSocket(true);
    setRecState("idle");
    setLecture(null);
    setTitle("");
    setNotes("");
    setSegments([]);
    setElapsedMs(0);
    setError(null);
    setWarning(null);
    setNotesStatus("idle");
    accumulatedRef.current = 0;
    startedAtRef.current = null;
  };

  useEffect(() => {
    return () => {
      cleanupAudio();
      closeSocket(true);
      clearTimer();
    };
    // This effect intentionally runs only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    lectureId,
    title,
    notes,
    segments,
    elapsedMs,
    level,
    error,
    warning,
    notesStatus,
    startRecording,
    resumeLecture,
    pause,
    resume,
    stop,
    reset,
    clearError: () => setError(null),
    clearWarning: () => setWarning(null),
  };
}
