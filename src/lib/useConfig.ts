import { useCallback, useEffect, useState } from "react";
import type { Account, Project } from "./types";
import { deleteAccount, deleteProject, listAccounts, listProjects, saveAccount, saveProject } from "./tauri";
import { formatError } from "./errors";

/** Accounts + Projects, backed by `~/.sleipnir/config.toml` via Tauri commands. */
export function useConfig() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listAccounts(), listProjects()])
      .then(([a, p]) => {
        setAccounts(a);
        setProjects(p);
      })
      .catch((e) => setError(`Failed to load Accounts/Projects: ${formatError(e)}`))
      .finally(() => setLoaded(true));
  }, []);

  const upsertAccount = useCallback(async (account: Account) => {
    try {
      setAccounts(await saveAccount(account));
    } catch (e) {
      setError(`Failed to save account "${account.alias}": ${formatError(e)}`);
    }
  }, []);

  const removeAccount = useCallback(async (alias: string) => {
    try {
      setAccounts(await deleteAccount(alias));
    } catch (e) {
      setError(`Failed to delete account "${alias}": ${formatError(e)}`);
    }
  }, []);

  const upsertProject = useCallback(async (project: Project) => {
    try {
      setProjects(await saveProject(project));
    } catch (e) {
      setError(`Failed to save project "${project.name}": ${formatError(e)}`);
    }
  }, []);

  const removeProject = useCallback(async (name: string) => {
    try {
      setProjects(await deleteProject(name));
    } catch (e) {
      setError(`Failed to delete project "${name}": ${formatError(e)}`);
    }
  }, []);

  return {
    accounts,
    projects,
    loaded,
    upsertAccount,
    removeAccount,
    upsertProject,
    removeProject,
    /** Wholesale replacement, e.g. after a bulk import returns the full list. */
    replaceAccounts: setAccounts,
    error,
    clearError: () => setError(null),
  };
}
