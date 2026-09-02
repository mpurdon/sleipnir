import type { Account, Env, EnvTarget, Mode } from "./types";
import { classifyRole } from "./constants";

/**
 * The frontend's copy of engage-time role resolution.
 *
 * This mirrors `role_for_mode` and the fallback chain in
 * `src-tauri/src/aws/engage.rs`. Duplicating it is deliberate: without it
 * the UI can only find out whether an engage is possible by attempting one,
 * which is how a service whose roles are all custom-named came to offer
 * "ENGAGE POWERUSER" and fail every single time. Keep the two in step — the
 * Rust is the authority.
 */

/** Graceful degradation, and it only ever runs downward. */
export const MODE_CHAIN: Record<Mode, Mode[]> = {
  admin: ["admin", "powerUser", "readOnly"],
  powerUser: ["powerUser", "readOnly"],
  readOnly: ["readOnly"],
};

/** Mirrors engage.rs's `role_for_mode`. */
export function roleForMode(account: Account, target: EnvTarget, mode: Mode): string | null {
  const preferred = target.roleOverrides?.[mode] ?? account.roles[mode];
  const available = target.availableRoles ?? [];
  // Imported without role data (the manual escape hatch) — trust the
  // preference blindly, exactly as the backend does.
  if (available.length === 0) return preferred ?? null;
  if (preferred && available.includes(preferred)) return preferred;
  const candidates = available
    .filter((r) => classifyRole(r) === mode)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates[0] ?? null;
}

/** The env-target an engage would actually use, honouring the standalone
 * `global` rule from `resolve_target`. */
export function targetForEnv(account: Account, env: Env): { env: Env; target: EnvTarget } | null {
  const direct = account.environments[env];
  if (direct) return { env, target: direct };
  const global = account.environments.global;
  if (global && Object.keys(account.environments).length === 1) {
    return { env: "global", target: global };
  }
  return null;
}

export type Resolution =
  | { ok: true; env: Env; mode: Mode; role: string; fellBackFrom: Mode | null }
  | { ok: false; reason: string; availableRoles: string[] };

/**
 * What engage will do for this service at this selection — or why it cannot.
 *
 * Returning the reason rather than a bare null is the point: "no role on
 * this account maps to POWERUSER" is something the user can act on, where a
 * disabled button with no explanation is not.
 */
export function resolveEngage(account: Account, env: Env, mode: Mode): Resolution {
  const found = targetForEnv(account, env);
  if (!found) {
    const has = Object.keys(account.environments).join(", ").toUpperCase();
    return { ok: false, reason: `no account for this environment (has: ${has})`, availableRoles: [] };
  }
  for (const m of MODE_CHAIN[mode]) {
    const role = roleForMode(account, found.target, m);
    if (role) return { ok: true, env: found.env, mode: m, role, fellBackFrom: m === mode ? null : mode };
  }
  return {
    ok: false,
    reason: `no role here maps to ${mode === "powerUser" ? "POWERUSER" : mode.toUpperCase()} or lower`,
    availableRoles: found.target.availableRoles ?? [],
  };
}

/** Every role assignable on this service at this env, for the picker. */
export function availableRolesFor(account: Account, env: Env): string[] {
  return targetForEnv(account, env)?.target.availableRoles ?? [];
}
