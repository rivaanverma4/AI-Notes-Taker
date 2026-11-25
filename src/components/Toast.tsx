import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export type ToastKind = "info" | "success" | "error";

interface ToastProps {
  message: string;
  kind?: ToastKind;
  onClose: () => void;
}

export function Toast({ message, kind = "info", onClose }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, kind === "error" ? 8000 : 5000);
    return () => window.clearTimeout(timer);
  }, [message, kind, onClose]);

  const Icon =
    kind === "success" ? CheckCircle2 : kind === "error" ? AlertTriangle : Info;

  return (
    <div className={`toast toast-${kind}`} role="status">
      <Icon size={17} />
      <span>{message}</span>
      <button type="button" className="icon-button toast-close" onClick={onClose} aria-label="Dismiss">
        <X size={15} />
      </button>
    </div>
  );
}
