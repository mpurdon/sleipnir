import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Tour, TourStep } from "./types";
import { tourById, TOURS } from "./tours";

const COMPLETED_KEY = "sleipnir.tours.completed";
const FIRST_RUN_KEY = "sleipnir.tours.firstRunOffered";

/**
 * Tour progress is UI preference, not application state, so it lives in the
 * webview's localStorage rather than `~/.sleipnir/state.json` — nothing the
 * backend needs to know, and nothing worth a config migration.
 *
 * Every read is defensive: a corrupt or absent value must degrade to "no
 * tours completed" and never throw, because a parse error here would take
 * the whole app down on mount.
 */
function readCompleted(): string[] {
  try {
    const raw = localStorage.getItem(COMPLETED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeCompleted(ids: string[]): void {
  try {
    localStorage.setItem(COMPLETED_KEY, JSON.stringify(ids));
  } catch {
    /* private mode, or storage disabled — tours simply re-offer */
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* non-fatal */
  }
}

export type ActiveTour = {
  tour: Tour;
  /** Index into the tour's *visible* steps, not its declared steps. */
  index: number;
  step: TourStep;
  total: number;
};

export function useTour() {
  const [completed, setCompleted] = useState<string[]>(() => readCompleted());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  /** Bumped to force a re-evaluation of which steps have live anchors. */
  const [probe, setProbe] = useState(0);

  const tour = activeId ? tourById(activeId) ?? null : null;

  /**
   * Steps whose anchor is missing AND that asked to be skipped are dropped.
   * Recomputed on `probe` so a step becomes available as soon as the drawer
   * carrying its anchor has opened.
   */
  const steps = useMemo(() => {
    if (!tour) return [];
    void probe;
    return tour.steps.filter((s) => {
      if (!s.skipIfMissing) return true;
      return s.anchor ? document.querySelector(`[data-tour="${s.anchor}"]`) !== null : true;
    });
  }, [tour, probe]);

  // Re-probe shortly after a step change: the drawer a step needs may still
  // be sliding open, so the anchor can appear a beat after we ask for it.
  useEffect(() => {
    if (!tour) return;
    const timers = [80, 260, 520].map((ms) => setTimeout(() => setProbe((p) => p + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [tour, index]);

  const finish = useCallback(
    (id: string, markDone: boolean) => {
      setActiveId(null);
      setIndex(0);
      if (!markDone) return;
      setCompleted((prev) => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id];
        writeCompleted(next);
        return next;
      });
    },
    [],
  );

  const start = useCallback((id: string) => {
    if (!tourById(id)) return;
    setActiveId(id);
    setIndex(0);
    setProbe((p) => p + 1);
  }, []);

  const next = useCallback(() => {
    if (!tour) return;
    setIndex((i) => {
      if (i + 1 < steps.length) return i + 1;
      // Last step: completing is the natural end, so mark it done.
      finish(tour.id, true);
      return 0;
    });
  }, [tour, steps.length, finish]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  /** Dismissing early does not mark the tour complete — it stays offered. */
  const dismiss = useCallback(() => {
    if (tour) finish(tour.id, false);
  }, [tour, finish]);

  const resetAll = useCallback(() => {
    setCompleted([]);
    writeCompleted([]);
  }, []);

  // Guard against a step index left past the end when steps shrink (an
  // anchor disappearing mid-tour, e.g. the last profile was disengaged).
  const safeIndex = steps.length === 0 ? 0 : Math.min(index, steps.length - 1);

  const active: ActiveTour | null =
    tour && steps.length > 0
      ? { tour, index: safeIndex, step: steps[safeIndex]!, total: steps.length }
      : null;

  /**
   * The first-run tour is offered once, and only to someone who has not set
   * up an org yet — the one moment it is genuinely useful. `offerFirstRun`
   * is called by the app once it knows whether any orgs exist.
   */
  const offeredRef = useRef(false);
  const offerFirstRun = useCallback(
    (hasOrgs: boolean) => {
      if (offeredRef.current || hasOrgs || readFlag(FIRST_RUN_KEY)) return;
      offeredRef.current = true;
      writeFlag(FIRST_RUN_KEY);
      start("first-run");
    },
    [start],
  );

  return {
    tours: TOURS,
    completed,
    active,
    start,
    next,
    back,
    dismiss,
    resetAll,
    offerFirstRun,
    isCompleted: (id: string) => completed.includes(id),
  };
}
