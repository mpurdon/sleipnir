import { describe, expect, test } from "bun:test";
import { availableRolesFor, resolveEngage } from "./roles";
import type { Account, Env, EnvTarget, Mode } from "./types";

/**
 * roles.ts duplicates `role_for_mode` and `resolve_target` from
 * src-tauri/src/aws/engage.rs so the UI can predict an engage instead of
 * discovering the answer by failing one. Duplication drifts, so these lock
 * the behaviours that matter — the Rust remains the authority.
 */

function account(
  roles: Partial<Record<Mode, string>>,
  environments: Partial<Record<Env, EnvTarget>>,
): Account {
  return { alias: "svc", org: "acme", displayName: "Svc", environments, roles };
}

const standalone = (available: string[], roleOverrides?: Partial<Record<Mode, string>>) => ({
  global: { accountId: "1", availableRoles: available, roleOverrides },
});

describe("custom-named permission sets", () => {
  // The reported bug: an account whose only role is ClaudeCodeBedrockAccess
  // matched no mode, so the UI offered ENGAGE POWERUSER and it failed every
  // time.
  const svc = account({}, standalone(["ClaudeCodeBedrockAccess"]));

  test("do not resolve on their own", () => {
    const r = resolveEngage(svc, "dev", "powerUser");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.availableRoles).toEqual(["ClaudeCodeBedrockAccess"]);
  });

  test("are offered to the picker so the user can pin one", () => {
    expect(availableRolesFor(svc, "dev")).toEqual(["ClaudeCodeBedrockAccess"]);
  });

  test("resolve once pinned", () => {
    const pinned = account(
      { powerUser: "ClaudeCodeBedrockAccess" },
      standalone(["ClaudeCodeBedrockAccess"], { powerUser: "ClaudeCodeBedrockAccess" }),
    );
    const r = resolveEngage(pinned, "dev", "powerUser");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role).toBe("ClaudeCodeBedrockAccess");
      // A standalone service engages through its single `global` target
      // whatever env is requested.
      expect(r.env).toBe("global");
    }
  });
});

describe("mode resolution", () => {
  test("a classified role resolves with no configuration", () => {
    const r = resolveEngage(account({}, standalone(["PowerUserAccess", "ReadOnlyAccess"])), "dev", "powerUser");
    expect(r.ok && r.role).toBe("PowerUserAccess");
  });

  test("the shortest classified candidate wins, matching the Rust sort", () => {
    const r = resolveEngage(account({}, standalone(["SSTPowerUserAccess", "PowerUserAccess"])), "dev", "powerUser");
    expect(r.ok && r.role).toBe("PowerUserAccess");
  });

  test("falls back downward and says so", () => {
    const r = resolveEngage(account({}, standalone(["ReadOnlyAccess"])), "dev", "admin");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("readOnly");
      expect(r.fellBackFrom).toBe("admin");
    }
  });

  // The safety invariant: asking for less must never grant more.
  test("NEVER escalates", () => {
    const r = resolveEngage(account({}, standalone(["AdministratorAccess"])), "dev", "readOnly");
    expect(r.ok).toBe(false);
  });

  test("an explicit override beats the service-wide preference", () => {
    const svc = account(
      { powerUser: "PowerUserAccess" },
      standalone(["PowerUserAccess", "SSTPowerUserAccess"], { powerUser: "SSTPowerUserAccess" }),
    );
    expect(resolveEngage(svc, "dev", "powerUser").ok && resolveEngage(svc, "dev", "powerUser")).toMatchObject({
      role: "SSTPowerUserAccess",
    });
  });

  test("a preference not actually available on the env is ignored", () => {
    const svc = account({ powerUser: "NotGrantedHere" }, standalone(["ReadOnlyAccess"]));
    const r = resolveEngage(svc, "dev", "powerUser");
    // Falls through to readOnly rather than trying a role AWS never granted.
    expect(r.ok && r.role).toBe("ReadOnlyAccess");
  });

  test("with no role data recorded the preference is trusted", () => {
    // The manual add-account escape hatch records no availableRoles.
    const r = resolveEngage(account({ powerUser: "Whatever" }, { global: { accountId: "1" } }), "dev", "powerUser");
    expect(r.ok && r.role).toBe("Whatever");
  });
});

describe("environments", () => {
  test("a multi-env service refuses an env it has no account for", () => {
    const svc = account({}, { dev: { accountId: "1", availableRoles: ["ReadOnlyAccess"] } });
    const r = resolveEngage(svc, "prd", "readOnly");
    expect(r.ok).toBe(false);
  });

  test("but a standalone service takes any requested env to global", () => {
    const r = resolveEngage(account({}, standalone(["ReadOnlyAccess"])), "prd", "readOnly");
    expect(r.ok && r.env).toBe("global");
  });
});
