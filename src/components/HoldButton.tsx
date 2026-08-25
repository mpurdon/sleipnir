import { useEffect, useRef, useState } from "react";

/**
 * Tiered-safety engage button. In hold mode (prd+admin) it requires a
 * ~1.2s press — a deliberate motor action a confirmation-dialog reflex
 * can't click through — with a fill animation showing progress and an
 * informative label naming exactly what's about to happen. In plain mode
 * it's an ordinary click.
 */
export function HoldButton({
  label,
  holdLabel,
  color,
  requireHold,
  disabled,
  onConfirm,
  className,
  holdMs = 1200,
}: {
  label: string;
  /** Shown while holding, e.g. "ADMIN → PRODUCTION — HOLD". */
  holdLabel?: string;
  color: string;
  requireHold: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  className?: string;
  holdMs?: number;
}) {
  const [fraction, setFraction] = useState(0);
  const [holding, setHolding] = useState(false);
  const raf = useRef<number | null>(null);
  const start = useRef(0);
  const fired = useRef(false);

  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
  }, []);

  function beginHold() {
    if (disabled) return;
    fired.current = false;
    setHolding(true);
    start.current = performance.now();
    const tick = (t: number) => {
      const f = Math.min(1, (t - start.current) / holdMs);
      setFraction(f);
      if (f >= 1) {
        if (!fired.current) {
          fired.current = true;
          setHolding(false);
          setFraction(0);
          onConfirm();
        }
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }

  function endHold() {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    setHolding(false);
    setFraction(0);
  }

  if (!requireHold) {
    return (
      <button
        className={`engage-btn hover-glow neon ${className ?? ""}`}
        style={{ background: color, color: "var(--c-void)" }}
        disabled={disabled}
        onClick={onConfirm}
      >
        {label}
      </button>
    );
  }

  return (
    <button
      className={`engage-btn hold-btn ${className ?? ""}`}
      style={{ borderColor: color, color: holding ? "var(--c-void)" : color }}
      disabled={disabled}
      onPointerDown={beginHold}
      onPointerUp={endHold}
      onPointerLeave={endHold}
      onPointerCancel={endHold}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !holding) beginHold();
      }}
      onKeyUp={endHold}
    >
      <span className="hold-btn-fill" style={{ width: `${fraction * 100}%`, background: color }} />
      <span className="hold-btn-label">{holding ? (holdLabel ?? label) : label}</span>
    </button>
  );
}
