import { useCallback, useEffect, useRef, useState } from "react";
import type { Org } from "./types";
import {
  deleteOrg,
  listOrgs,
  loginOrg,
  onLoginProgress,
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

  return { orgs, login, refresh, activeLoginName, activeLoginProgress, addOrg, removeOrg, signOut, error, clearError: () => setError(null) };
}
