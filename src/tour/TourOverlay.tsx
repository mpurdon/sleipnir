import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ActiveTour } from "./useTour";
import { Slab } from "../theme";

type Rect = { top: number; left: number; width: number; height: number };

const GAP = 10;
/** Keep the card clear of the window edges in the 380px-wide rail. */
const MARGIN = 8;

function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/**
 * Tracks an anchor's position for as long as the step is showing.
 *
 * Three sources, because none alone is sufficient:
 *
 * - A layout effect measures synchronously whenever the step changes. This
 *   is the correctness guarantee: the spotlight is right before the first
 *   paint, without needing a single animation frame to have run.
 * - A rAF loop tracks the drawer animation. Opening a drawer resizes the
 *   *native window* and slides the panel in, so the anchor's viewport rect
 *   changes every frame through a path no DOM observer reports.
 * - visibilitychange and resize re-measure on the way back, because rAF is
 *   throttled to *zero* in a hidden or occluded window. Relying on rAF
 *   alone leaves the spotlight frozen over whatever the previous step
 *   pointed at — silently highlighting the wrong control.
 *
 * State is only set when the rect actually changes, so a settled overlay
 * costs one comparison per frame and no re-renders.
 */
function useAnchorRect(anchor: string | undefined, stepKey: number): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  const current = useRef<Rect | null>(null);

  const measure = useCallback(() => {
    const el = anchor ? document.querySelector(`[data-tour="${anchor}"]`) : null;
    let next: Rect | null = null;
    if (el) {
      const r = el.getBoundingClientRect();
      // A zero-size box is an element that exists but is not laid out yet;
      // treat it as absent so the card centres instead of pointing at the
      // top-left corner.
      if (r.width > 0 && r.height > 0) {
        next = { top: r.top, left: r.left, width: r.width, height: r.height };
      }
    }
    if (!rectsEqual(current.current, next)) {
      current.current = next;
      setRect(next);
    }
  }, [anchor]);

  useLayoutEffect(() => {
    measure();
  }, [measure, stepKey]);

  useEffect(() => {
    if (!anchor) return;
    let raf = requestAnimationFrame(function tick() {
      measure();
      raf = requestAnimationFrame(tick);
    });
    document.addEventListener("visibilitychange", measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", measure);
      window.removeEventListener("resize", measure);
    };
  }, [anchor, measure]);

  return rect;
}

export function TourOverlay({
  active,
  onNext,
  onBack,
  onDismiss,
}: {
  active: ActiveTour;
  onNext: () => void;
  onBack: () => void;
  onDismiss: () => void;
}) {
  const { step, index, total, tour } = active;
  const rect = useAnchorRect(step.anchor, index);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // Scroll the anchor into view when a step lands on something off-screen —
  // the rail scrolls, and the engaged list can be well below the fold.
  useEffect(() => {
    if (!step.anchor) return;
    const el = document.querySelector(`[data-tour="${step.anchor}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [step.anchor, index]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(340, vw - MARGIN * 2);
    const h = card.offsetHeight;

    if (!rect) {
      setCardPos({ top: Math.max(MARGIN, (vh - h) / 2), left: (vw - width) / 2, width });
      return;
    }

    // Prefer below the anchor, flip above when it would run off the bottom,
    // and fall back to centring when neither side fits.
    const below = rect.top + rect.height + GAP;
    const above = rect.top - GAP - h;
    let top: number;
    if (below + h <= vh - MARGIN) top = below;
    else if (above >= MARGIN) top = above;
    else top = Math.max(MARGIN, Math.min(vh - h - MARGIN, rect.top));

    const wanted = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(MARGIN, Math.min(vw - width - MARGIN, wanted));
    setCardPos({ top, left, width });
  }, [rect, step, index]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onBack();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, onBack, onDismiss]);

  const last = index === total - 1;

  // Portalled to <body> for the same reason as the connection-test modal:
  // the rail and drawer each form a stacking context and the rail clips
  // overflow, so an in-tree overlay gets buried or cropped.
  return createPortal(
    <div className="tour-root" role="dialog" aria-modal="true" aria-label={`${tour.title}: ${step.title}`}>
      {/* Click-through-proof scrim. With an anchor, the spotlight's huge
          outward box-shadow paints the scrim and leaves the target lit; the
          scrim below fills in for anchorless steps. */}
      {!rect && <div className="tour-scrim" onClick={onDismiss} />}
      {rect && (
        <div
          className="tour-spot"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      )}

      <div
        ref={cardRef}
        className="tour-card"
        style={cardPos ? { top: cardPos.top, left: cardPos.left, width: cardPos.width } : { opacity: 0 }}
      >
        <Slab cut={6} tint="var(--c-yellow)" className="tour-slab">
          <div className="tour-head">
            <span className="label" style={{ color: "var(--c-yellow)" }}>
              {tour.title}
            </span>
            <span className="label" style={{ color: "var(--c-dim)" }}>
              {index + 1}/{total}
            </span>
            <button className="label hover-glow tour-skip" onClick={onDismiss} title="Close the tour (Esc)">
              ✕
            </button>
          </div>

          <h2 className="tour-title">{step.title}</h2>
          <p className="tour-body">{step.body}</p>

          <div className="tour-dots" aria-hidden="true">
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={`tour-dot${i === index ? " tour-dot-on" : ""}`} />
            ))}
          </div>

          <div className="tour-actions">
            <button
              className="label hover-glow tour-back"
              onClick={onBack}
              disabled={index === 0}
              style={{ color: index === 0 ? "var(--c-edge)" : "var(--c-dim)" }}
            >
              ‹ BACK
            </button>
            <button className="tour-next hover-glow neon" onClick={onNext}>
              {last ? "DONE" : "NEXT ›"}
            </button>
          </div>
        </Slab>
      </div>
    </div>,
    document.body,
  );
}
