import { useCallback, useEffect, useState } from "react";
import type { Account, DeletedProject, Project } from "./types";
import {
  deleteAccount,
  deleteProject,
  listAccounts,
  listDeletedProjects,
  listProjects,
  purgeProject,
  restoreProject,
  saveAccount,
  saveProject,
} from "./tauri";
import { formatError } from "./errors";

/** Accounts + Projects, backed by `~/.sleipnir/config.toml` via Tauri commands. */
export function useConfig() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [deletedProjects, setDeletedProjects] = useState<DeletedProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listAccounts(), listProjects(), listDeletedProjects()])
      .then(([a, p, d]) => {
        setAccounts(a);
        setProjects(p);
        setDeletedProjects(d);
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

  /** Soft-delete. The project lands in the archive and can be restored. */
  const removeProject = useCallback(async (name: string) => {
    try {
      const out = await deleteProject(name);
      setProjects(out.projects);
      setDeletedProjects(out.deleted);
    } catch (e) {
      setError(`Failed to delete project "${name}": ${formatError(e)}`);
    }
  }, []);

  const restoreProjectByName = useCallback(async (name: string) => {
    try {
      const out = await restoreProject(name);
      setProjects(out.projects);
      setDeletedProjects(out.deleted);
    } catch (e) {
      // The common failure is a name clash, and the backend's message says
      // exactly what to do about it — surface it rather than a generic one.
      setError(`Could not restore "${name}": ${formatError(e)}`);
    }
  }, []);

  const purgeProjectByName = useCallback(async (name: string) => {
    try {
      const out = await purgeProject(name);
      setProjects(out.projects);
      setDeletedProjects(out.deleted);
    } catch (e) {
      setError(`Failed to purge project "${name}": ${formatError(e)}`);
    }
  }, []);

  return {
    accounts,
    projects,
    deletedProjects,
    restoreProject: restoreProjectByName,
    purgeProject: purgeProjectByName,
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
