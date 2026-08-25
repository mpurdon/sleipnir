import { useCallback, useEffect, useRef, useState } from "react";
import type { Collision, EngageOutcome, EngageRequest, EngageProgressEvent, AppState } from "./types";
import { engage as engageCmd, onEngageProgress } from "./tauri";
import { formatError } from "./errors";

export type RowStatus = { status: "pending" | "assuming" | "done" | "failed"; message?: string };

/**
 * Drives one engage operation: per-row live status from `engage:progress`
 * events, the collision-acknowledge round-trip, and RETRY FAILED scoped to
 * just the rows that failed. `onStateChange` receives the fresh AppState
 * carried back on every completed engage.
 */
export function useEngage(onStateChange: (s: AppState) => void) {
  const [rows, setRows] = useState<Record<string, RowStatus>>({});
  const [busy, setBusy] = useState(false);
  const [collisions, setCollisions] = useState<Collision[] | null>(null);
  const [outcome, setOutcome] = useState<EngageOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastRequest = useRef<EngageRequest | null>(null);
  const unlisten = useRef<(() => void) | null>(null);

  useEffect(() => {
    onEngageProgress((p: EngageProgressEvent) => {
      setRows((prev) =>
        p.alias in prev ? { ...prev, [p.alias]: { status: p.status, message: p.message ?? undefined } } : prev,
      );
    }).then((u) => {
      unlisten.current = u;
    });
    return () => unlisten.current?.();
  }, []);

  const run = useCallback(
    async (request: EngageRequest) => {
      lastRequest.current = request;
      setBusy(true);
      setError(null);
      setCollisions(null);
      setOutcome(null);
      setRows(Object.fromEntries(request.aliases.map((a) => [a, { status: "pending" as const }])));
      try {
        const out = await engageCmd(request);
        if (out.collisions.length > 0) {
          setCollisions(out.collisions);
          setRows({});
        } else {
          setOutcome(out);
          onStateChange(out.state);
        }
      } catch (e) {
        setError(formatError(e));
      } finally {
        setBusy(false);
      }
    },
    [onStateChange],
  );

  const acknowledgeCollisions = useCallback(() => {
    if (lastRequest.current) void run({ ...lastRequest.current, acknowledgeCollisions: true });
  }, [run]);

  const dismissCollisions = useCallback(() => setCollisions(null), []);

  const retryFailed = useCallback(() => {
    const req = lastRequest.current;
    const failed = outcome?.failed.map((f) => f.alias) ?? [];
    // Scoped retry: never re-engages what already succeeded.
    if (req && failed.length > 0) void run({ ...req, aliases: failed, acknowledgeCollisions: true });
  }, [run, outcome]);

  const reset = useCallback(() => {
    setRows({});
    setOutcome(null);
    setError(null);
    setCollisions(null);
  }, []);

  return { rows, busy, collisions, outcome, error, run, acknowledgeCollisions, dismissCollisions, retryFailed, reset };
}
