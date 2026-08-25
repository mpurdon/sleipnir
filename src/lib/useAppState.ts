import { useCallback, useEffect, useState } from "react";
import type { AppState } from "./types";
import { disengage, disengageAll, getState, setPin } from "./tauri";
import { formatError } from "./errors";

const EMPTY: AppState = { pins: [], lastEngage: {}, engaged: {} };

/** Runtime state from `~/.sleipnir/state.json` — pins, last-engage memory,
 * and the live engaged-profile map. */
export function useAppState() {
  const [state, setState] = useState<AppState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getState()
      .then(setState)
      .catch((e) => setError(`Failed to load app state: ${formatError(e)}`));
  }, []);

  const togglePin = useCallback(async (project: string, pinned: boolean) => {
    try {
      setState(await setPin(project, pinned));
    } catch (e) {
      setError(`Failed to update pin: ${formatError(e)}`);
    }
  }, []);

  const disengageProfiles = useCallback(async (profiles: string[]) => {
    try {
      setState(await disengage(profiles));
    } catch (e) {
      setError(`Failed to disengage: ${formatError(e)}`);
    }
  }, []);

  const disengageEverything = useCallback(async () => {
    try {
      setState(await disengageAll());
    } catch (e) {
      setError(`Failed to disengage all: ${formatError(e)}`);
    }
  }, []);

  return {
    state,
    replaceState: setState,
    togglePin,
    disengageProfiles,
    disengageEverything,
    error,
    clearError: () => setError(null),
  };
}
