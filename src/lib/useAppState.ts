import { useCallback, useEffect, useState } from "react";
import type { AppState, RetainedProfile } from "./types";
import { attachEngagedToProject, disengage, disengageAll, getState, refreshEngagedCredentials, setPin } from "./tauri";
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

  /** Rotate the moment the window is looked at again.
   *
   * The backend sweep is the real schedule, but its timer is driven by a
   * clock that does not advance while the machine is asleep, so a window
   * being shown after the lid was closed is a strong hint that the keys on
   * disk are older than the timer believes. Checking here costs nothing
   * when everything is fresh, and it is the one moment the user is most
   * likely to be about to rely on a profile. */
  useEffect(() => {
    // Unminimising fires `visibilitychange` and `focus` together, and
    // alt-tabbing fires `focus` alone — neither is worth a second pass, so
    // collapse a burst into one.
    let lastWake = 0;
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastWake < 1_000) return;
      lastWake = Date.now();
      // Nothing to re-read afterwards: rotation rewrites `~/.aws` and the
      // credential cache, never `state.json`. What it changes is health,
      // and the rail polls that.
      void refreshEngagedCredentials().catch(() => {
        /* the rail's credential badges report the damage; a failed
           opportunistic refresh is not itself worth an error banner */
      });
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
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
