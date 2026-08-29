import { useCallback, useEffect, useRef, useState } from "react";
import type { Org } from "./types";
import {
  deleteOrg,
  listOrgs,
  loginOrg,
  onLoginProgress,
  refreshSession,
  saveOrg,
  signOutOrg,
  type LoginProgress,
  type OrgConfig,
} from "./tauri";
import { formatError } from "./errors";

/**
 * Org list + login orchestration. Only one login runs at a time in this UI
 * (the `sso:login-progress` event carries no org identifier, since only one
 * device-auth flow is ever in flight) — other Org rows are disabled while
 * `activeLoginName` is set.
 */
export function useOrgs() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeLoginName, setActiveLoginName] = useState<string | null>(null);
  const [activeLoginProgress, setActiveLoginProgress] = useState<LoginProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlisten = useRef<(() => void) | null>(null);

  useEffect(() => {
    listOrgs()
      .then(setOrgs)
      .catch((e) => setError(`Failed to load Orgs: ${formatError(e)}`));

    onLoginProgress((p) => setActiveLoginProgress(p)).then((u) => {
      unlisten.current = u;
    });

    return () => unlisten.current?.();
  }, []);

  // Background session upkeep — the AWS access token only lives 1 hour,
  // but the refresh token spans the whole SSO session (typically 8-12h).
  // Rolling the access token over silently before it lapses means the
  // user only ever sees the REAL session boundary, exactly like Leapp.
  useEffect(() => {
    let cancelled = false;
    async function upkeep() {
      let list: Org[];
      try {
        list = await listOrgs();
      } catch {
        return;
      }
      for (const org of list) {
        if (cancelled) return;
        const msLeft = org.tokenExpiresAt ? new Date(org.tokenExpiresAt).getTime() - Date.now() : -1;
        // Refresh when lapsed or within 10 minutes of lapsing; a dead
        // session fails harmlessly and stays visibly expired.
        if (org.tokenExpiresAt !== null && msLeft < 10 * 60_000) {
          try {
            const updated = await refreshSession(org.name);
            if (!cancelled) setOrgs((prev) => prev.map((o) => (o.name === updated.name ? updated : o)));
          } catch {
            /* headless refresh is best-effort */
          }
        }
      }
    }
    void upkeep();
    const id = setInterval(() => void upkeep(), 4 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const login = useCallback(async (name: string) => {
    if (activeLoginName) return;
    setActiveLoginName(name);
    setActiveLoginProgress({ stage: "registering" });
    setError(null);
    try {
      const updated = await loginOrg(name);
      setOrgs((prev) => prev.map((o) => (o.name === name ? updated : o)));
    } catch (e) {
      setError(`Login failed for ${name}: ${formatError(e)}`);
    } finally {
      setActiveLoginName(null);
      setActiveLoginProgress(null);
    }
  }, [activeLoginName]);

  /** Re-reads org statuses — call after backend operations that may have
   * silently refreshed a token (scan/engage chain login internally). */
  const refresh = useCallback(() => {
    listOrgs()
      .then(setOrgs)
      .catch(() => {});
  }, []);

  /** Silent single-org token refresh, mapped surgically into state — the
   * drawer's ↻ REFRESH action. */
  const refreshOne = useCallback(async (name: string) => {
    try {
      const updated = await refreshSession(name);
      setOrgs((prev) => prev.map((o) => (o.name === updated.name ? updated : o)));
    } catch (e) {
      setError(`Failed to refresh ${name}: ${formatError(e)}`);
    }
  }, []);

  const addOrg = useCallback(async (org: OrgConfig) => {
    try {
      setOrgs(await saveOrg(org));
    } catch (e) {
      setError(`Failed to save Org: ${formatError(e)}`);
    }
  }, []);

  const removeOrg = useCallback(async (name: string) => {
    try {
      setOrgs(await deleteOrg(name));
    } catch (e) {
      setError(`Failed to delete Org: ${formatError(e)}`);
    }
  }, []);

  const signOut = useCallback(async (name: string) => {
    try {
      const updated = await signOutOrg(name);
      setOrgs((prev) => prev.map((o) => (o.name === name ? updated : o)));
    } catch (e) {
      setError(`Failed to sign out of ${name}: ${formatError(e)}`);
    }
  }, []);

  return { orgs, login, refresh, refreshOne, activeLoginName, activeLoginProgress, addOrg, removeOrg, signOut, error, clearError: () => setError(null) };
}
