import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Account,
  AppState,
  DiscoveredAccount,
  EngageOutcome,
  EngageProgressEvent,
  EngageRequest,
  GroupedDiscovery,
  Org,
  Project,
} from "./types";

// Mirrors src-tauri/src/commands.rs's OrgStatus (serde rename_all = camelCase).
interface OrgStatusPayload {
  name: string;
  startUrl: string;
  region: string;
  tokenExpiresAt: string | null;
}

function toOrg(s: OrgStatusPayload): Org {
  return { name: s.name, startUrl: s.startUrl, region: s.region, tokenExpiresAt: s.tokenExpiresAt };
}

export async function listOrgs(): Promise<Org[]> {
  const orgs = await invoke<OrgStatusPayload[]>("list_orgs");
  return orgs.map(toOrg);
}

export async function loginOrg(name: string): Promise<Org> {
  const status = await invoke<OrgStatusPayload>("login_org", { name });
  return toOrg(status);
}

/** Headless background token upkeep — never opens a browser. */
export async function refreshSession(name: string): Promise<Org> {
  const status = await invoke<OrgStatusPayload>("refresh_session", { name });
  return toOrg(status);
}

export interface OrgConfig {
  name: string;
  startUrl: string;
  region: string;
}

export async function saveOrg(org: OrgConfig): Promise<Org[]> {
  const orgs = await invoke<OrgStatusPayload[]>("save_org", { org });
  return orgs.map(toOrg);
}

export async function deleteOrg(name: string): Promise<Org[]> {
  const orgs = await invoke<OrgStatusPayload[]>("delete_org", { name });
  return orgs.map(toOrg);
}

export async function signOutOrg(name: string): Promise<Org> {
  const status = await invoke<OrgStatusPayload>("sign_out_org", { name });
  return toOrg(status);
}

// Mirrors src-tauri/src/aws/sso_oidc.rs's LoginProgress (serde tag = "stage").
export type LoginProgress =
  | { stage: "registering" }
  | { stage: "awaitingBrowserApproval"; verificationUriComplete: string }
  | { stage: "polling" }
  | { stage: "done" };

export function onLoginProgress(cb: (p: LoginProgress) => void): Promise<() => void> {
  return listen<LoginProgress>("sso:login-progress", (e) => cb(e.payload));
}

export const listAccounts = () => invoke<Account[]>("list_accounts");
export const saveAccount = (account: Account) => invoke<Account[]>("save_account", { account });
export const deleteAccount = (alias: string) => invoke<Account[]>("delete_account", { alias });

export const listProjects = () => invoke<Project[]>("list_projects");
export const saveProject = (project: Project) => invoke<Project[]>("save_project", { project });
export const deleteProject = (name: string) => invoke<Project[]>("delete_project", { name });

export const discoverAccounts = (orgName: string) =>
  invoke<DiscoveredAccount[]>("discover_accounts", { orgName });

export const discoverGrouped = (orgName: string) =>
  invoke<GroupedDiscovery>("discover_grouped", { orgName });

export const importAccounts = (accounts: Account[]) =>
  invoke<Account[]>("import_accounts", { accounts });

export interface DiscoverProgress {
  done: number;
  total: number;
}

export function onDiscoverProgress(cb: (p: DiscoverProgress) => void): Promise<() => void> {
  return listen<DiscoverProgress>("discover:progress", (e) => cb(e.payload));
}

export interface ProfileTest {
  ok: boolean;
  account: string | null;
  arn: string | null;
  userId: string | null;
  message: string | null;
  ms: number;
}

/** Runs `aws sts get-caller-identity --profile <alias>` — the real
 * terminal path through ~/.aws/config and credential_process. */
export const testProfile = (alias: string) => invoke<ProfileTest>("test_profile", { alias });

export interface RenameOutcome {
  accounts: Account[];
  state: AppState;
}

/** Renames a service alias everywhere: config, projects, engaged state,
 * creds cache, and the ~/.aws/config profile stanza. */
export const renameAccount = (oldAlias: string, newAlias: string) =>
  invoke<RenameOutcome>("rename_account", { oldAlias, newAlias });

export const getState = () => invoke<AppState>("get_state");
export const setPin = (project: string, pinned: boolean) => invoke<AppState>("set_pin", { project, pinned });
export const engage = (request: EngageRequest) => invoke<EngageOutcome>("engage", { request });
export const disengage = (profiles: string[]) => invoke<AppState>("disengage", { profiles });
export const disengageAll = () => invoke<AppState>("disengage_all");
/** Rotates static ~/.aws/credentials keys for engaged profiles nearing
 * expiry; returns how many were refreshed. */
export const refreshEngagedCredentials = () => invoke<number>("refresh_engaged_credentials");

export function onEngageProgress(cb: (p: EngageProgressEvent) => void): Promise<() => void> {
  return listen<EngageProgressEvent>("engage:progress", (e) => cb(e.payload));
}

export interface AppPaths {
  configPath: string;
  logDir: string;
}

export const appPaths = () => invoke<AppPaths>("app_paths");
export const openInFileManager = (path: string) => invoke<void>("open_in_file_manager", { path });
export const readLogs = (maxLines?: number) => invoke<string>("read_logs", { maxLines });
