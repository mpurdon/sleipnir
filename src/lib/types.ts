// Mirrors the Rust data model in src-tauri/src/config/schema.rs (see the
// plan doc). Kept in one file since this is the shape crossing the
// Tauri command boundary.

export type Env = "sbx" | "dev" | "stg" | "prd" | "global";
export type Mode = "readOnly" | "powerUser" | "admin";

export interface Org {
  name: string;
  startUrl: string;
  region: string;
  /** null until a device-auth login has completed and the token cache has been read. */
  tokenExpiresAt: string | null;
}

export interface EnvTarget {
  accountId: string;
  /** AWS account display name, for recognition in the UI. */
  accountName?: string;
  region?: string;
  /** SSO permission-set names actually assigned on this env's account. */
  availableRoles?: string[];
  /** Explicit per-env role picks (mode → role); wins over Account.roles at engage time. */
  roleOverrides?: Partial<Record<Mode, string>>;
}

export interface Account {
  /** Machine slug — doubles as the AWS profile name. */
  alias: string;
  /** Human name for the UI ("R&D", "Core Services"); may be "" on old configs. */
  displayName?: string;
  org: string;
  environments: Partial<Record<Env, EnvTarget>>;
  roles: Partial<Record<Mode, string>>;
}

export interface Project {
  name: string;
  org: string;
  members: string[]; // Account.alias[]
}

// Mirrors src-tauri/src/state.rs.
export interface LastEngage {
  env: Env;
  mode: Mode;
  atUnixMs: number;
}

export interface EngagedProfile {
  org: string;
  env: Env;
  mode: Mode;
  accountId: string;
  roleName: string;
  region: string;
  project?: string;
  engagedAtUnixMs: number;
}

export interface AppState {
  pins: string[];
  /** Keyed "project:<name>" or "service:<alias>". */
  lastEngage: Record<string, LastEngage>;
  /** Profile alias → live engagement; authority for `sleipnir creds`. */
  engaged: Record<string, EngagedProfile>;
}

// Mirrors src-tauri/src/aws/engage.rs.
export interface EngageRequest {
  orgName: string;
  project?: string;
  aliases: string[];
  env: Env;
  mode: Mode;
  acknowledgeCollisions?: boolean;
}

export interface Collision {
  alias: string;
  current: EngagedProfile;
}

export interface EngagedRow {
  alias: string;
  env: Env;
  /** Mode actually engaged — may be lower than requested (admin → powerUser → readOnly fallback). */
  mode: Mode;
  roleName: string;
  accountId: string;
  note?: string;
}

export interface FailedRow {
  alias: string;
  message: string;
}

export interface EngageOutcome {
  collisions: Collision[];
  succeeded: EngagedRow[];
  failed: FailedRow[];
  state: AppState;
}

export interface EngageProgressEvent {
  alias: string;
  status: "assuming" | "done" | "failed";
  message: string | null;
}

// Mirrors src-tauri/src/aws/sso.rs's DiscoveredAccount.
export interface DiscoveredAccount {
  accountId: string;
  accountName: string | null;
  emailAddress: string | null;
  roles: string[];
}

// Mirrors src-tauri/src/discovery.rs's ProposedService / GroupedDiscovery.
export interface RoleChoice {
  mode: Mode;
  candidates: string[];
  picked: string;
}

export interface ProposedService {
  account: Account;
  displayName: string;
  /** Modes where multiple roles classify the same — rendered as inline picks. */
  roleChoices: RoleChoice[];
  /** Informational only (e.g. single-env explanation) — never a warning. */
  note?: string;
}

export interface GroupedDiscovery {
  services: ProposedService[];
  standalone: ProposedService[];
  totalAccounts: number;
}
