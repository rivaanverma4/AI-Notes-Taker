interface WaveformProps {
  level: number;
  active: boolean;
  paused?: boolean;
  bars?: number;
}

export function Waveform({ level, active, paused = false, bars = 28 }: WaveformProps) {
  return (
    <div
      className={`waveform ${active ? "is-active" : ""} ${paused ? "is-paused" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: bars }, (_, index) => {
        const phase = Math.sin(index * 1.73) * 0.5 + 0.5;
        const shimmer = Math.sin(index * 0.71 + level * 13) * 0.18 + 0.82;
        const height = active
          ? Math.max(0.12, Math.min(1, (0.18 + level * 1.4) * phase * shimmer + 0.08))
          : paused
            ? 0.08
            : 0.12 + (index % 4) * 0.018;
        return (
          <span
            key={index}
            className="wave-bar"
            style={{
              height: `${height * 100}%`,
              animationDelay: `${(index % 9) * 55}ms`,
            }}
          />
        );
      })}
    </div>
  );
}
