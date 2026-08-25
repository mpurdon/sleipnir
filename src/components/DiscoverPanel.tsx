import { useEffect, useMemo, useState } from "react";
import type { Account, DiscoveredAccount, Env, Mode } from "../lib/types";
import { ENVS } from "../lib/constants";
import { discoverAccounts } from "../lib/tauri";
import { Slab, SectionRule } from "../theme";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Best-effort Mode -> role-name guess from a discovered role list, since
 * role naming isn't consistent across accounts (see the plan's Data Model
 * section) — this is a starting point the user can override, not a promise. */
function guessRoles(roles: string[]): Partial<Record<Mode, string>> {
  const lower = (r: string) => r.toLowerCase();
  const find = (pred: (r: string) => boolean) => roles.find((r) => pred(lower(r)));
  const guess: Partial<Record<Mode, string>> = {};
  const admin = find((r) => r.includes("admin"));
  const power = find((r) => r.includes("power"));
  const readOnly = find((r) => r.includes("readonly") || r.includes("view"));
  if (admin) guess.admin = admin;
  if (power) guess.powerUser = power;
  if (readOnly) guess.readOnly = readOnly;
  return guess;
}

interface Row {
  discovered: DiscoveredAccount;
  included: boolean;
  alias: string;
  env: Env | "";
}

export function DiscoverPanel({
  orgName,
  existingAccounts,
  onAdd,
  onClose,
}: {
  orgName: string;
  existingAccounts: Account[];
  onAdd: (accounts: Account[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    discoverAccounts(orgName)
      .then((discovered) =>
        setRows(
          discovered.map((d) => ({
            discovered: d,
            included: false,
            alias: slugify(d.accountName ?? d.accountId),
            env: "",
          })),
        ),
      )
      .catch((e) => setError(String(e)));
  }, [orgName]);

  const includedCount = useMemo(() => rows?.filter((r) => r.included && r.env).length ?? 0, [rows]);

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev?.map((r, ri) => (ri === i ? { ...r, ...patch } : r)) ?? prev);
  }

  function addSelected() {
    if (!rows) return;
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      if (!row.included || !row.env || !row.alias.trim()) continue;
      const key = row.alias.trim();
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    const result: Account[] = [];
    for (const [alias, group] of groups) {
      const existing = existingAccounts.find((a) => a.alias === alias);
      const environments = { ...(existing?.environments ?? {}) };
      for (const row of group) {
        environments[row.env as Env] = { accountId: row.discovered.accountId };
      }
      const roles = existing?.roles ?? guessRoles(group[0]!.discovered.roles);
      result.push({ alias, org: orgName, environments, roles });
    }

    onAdd(result);
  }

  return (
    <div className="discover-panel">
      <div className="discover-header">
        <SectionRule title={`Discovered accounts — ${orgName}`} />
        <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={onClose}>
          CLOSE
        </button>
      </div>

      {error && (
        <Slab tint="var(--c-magenta)" cut={5} className="discover-error">
          {error}
        </Slab>
      )}

      {!rows && !error && <div className="label">LOADING…</div>}

      {rows && (
        <>
          <div className="discover-rows">
            {rows.map((row, i) => (
              <Slab key={row.discovered.accountId} cut={5} className="discover-row">
                <input
                  type="checkbox"
                  checked={row.included}
                  onChange={(e) => updateRow(i, { included: e.target.checked })}
                />
                <div className="discover-row-name">
                  <div>{row.discovered.accountName ?? row.discovered.accountId}</div>
                  <span className="label" style={{ color: "var(--c-dim)" }}>
                    {row.discovered.accountId} · {row.discovered.roles.length} role
                    {row.discovered.roles.length === 1 ? "" : "s"}
                  </span>
                </div>
                <select value={row.env} onChange={(e) => updateRow(i, { env: e.target.value as Env })}>
                  <option value="">env…</option>
                  {ENVS.map((e) => (
                    <option key={e} value={e}>
                      {e.toUpperCase()}
                    </option>
                  ))}
                </select>
                <input
                  className="discover-alias-input"
                  value={row.alias}
                  onChange={(e) => updateRow(i, { alias: e.target.value })}
                  placeholder="alias"
                />
              </Slab>
            ))}
          </div>

          <button
            className="engage-btn hover-glow"
            style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
            disabled={includedCount === 0}
            onClick={addSelected}
          >
            ADD {includedCount || ""} SELECTED
          </button>
        </>
      )}
    </div>
  );
}
