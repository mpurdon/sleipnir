import { useCallback, useEffect, useState } from "react";
import type { AppState, RetainedProfile } from "./types";
import { attachEngagedToProject, disengage, disengageAll, getState, setPin } from "./tauri";
import { formatError } from "./errors";

const EMPTY: AppState = { pins: [], lastEngage: {}, engaged: {} };

/** Runtime state from `~/.sleipnir/state.json` — pins, last-engage memory,
 * and the live engaged-profile map. */
export function useAppState() {
  const [state, setState] = useState<AppState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  /** Profiles a disengage deliberately left alone because another holder
   * still needs them. Shown briefly so a chip that does not disappear reads
   * as intended rather than as a click that failed. */
  const [retained, setRetained] = useState<RetainedProfile[]>([]);

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

  const disengageProfiles = useCallback(async (profiles: string[], project?: string) => {
    try {
      const out = await disengage(profiles, project);
      setState(out.state);
      setRetained(out.retained);
    } catch (e) {
      setError(`Failed to disengage: ${formatError(e)}`);
    }
  }, []);

  const attachToProject = useCallback(async (alias: string, project: string) => {
    try {
      setState(await attachEngagedToProject(alias, project));
    } catch (e) {
      setError(`Could not add "${alias}" to ${project}: ${formatError(e)}`);
    }
  }, []);

  const disengageEverything = useCallback(async () => {
    try {
      setRetained([]);
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
    attachToProject,
    retained,
    clearRetained: () => setRetained([]),
    error,
    clearError: () => setError(null),
  };
}
