import { useMemo, useState } from "react";
import type { Account, AppState, Env, Mode, Org } from "../lib/types";
import { accountName, ENVS, ENV_LABELS } from "../lib/constants";
import { availableRolesFor, resolveEngage, targetForEnv } from "../lib/roles";
import { renameAccount } from "../lib/tauri";
import { formatError } from "../lib/errors";
import { useEngage } from "../lib/useEngage";
import { clampSel, defaultSel, EngageFeedback, modeMeta, SelPills, type Sel } from "./engageUi";
import { DiscoveryHero } from "./DiscoveryHero";
import { HoldButton } from "./HoldButton";
import { Slab } from "../theme";

/** Inline editor for the AWS profile alias (`ghostinthefactory` → `gitf`). */
function AliasEditor({ alias, onRenamed }: { alias: string; onRenamed: (next: string) => Promise<void> }) {
  const [value, setValue] = useState(alias);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value.trim() !== alias;

  async function submit() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRenamed(value.trim());
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="alias-editor">
      <span className="label" style={{ color: "var(--c-dim)" }} title="AWS profile name">
        PROFILE
      </span>
      <input
        className="alias-input"
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setValue(alias);
        }}
      />
      {dirty && (
        <button className="label hover-glow" style={{ color: "var(--c-cyan)" }} disabled={busy} onClick={() => void submit()}>
          {busy ? "…" : "RENAME"}
        </button>
      )}
      {error && (
        <span className="label" style={{ color: "var(--c-magenta)", textTransform: "none" }}>
          {error}
        </span>
      )}
    </div>
  );
}

export function ServicesDrawer({
  org,
  accounts,
  state,
  needsLogin,
  onLogin,
  onStateChange,
  onImported,
  onSessionMaybeRefreshed,
  onSaveAccount,
}: {
  org: Org;
  accounts: Account[];
  state: AppState;
  needsLogin: boolean;
  onLogin: () => void;
  onStateChange: (s: AppState) => void;
  onImported: (accounts: Account[]) => void;
  onSessionMaybeRefreshed?: () => void;
  /** Persists a role pick. Needed because a service whose permission sets
   * are all custom-named has nothing the mode heuristic recognises, and
   * without an explicit pick it can never be engaged at all. */
  onSaveAccount: (a: Account) => void;
}) {
  const eng = useEngage(onStateChange);
  const [filter, setFilter] = useState("");
  const [sels, setSels] = useState<Record<string, Sel>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? accounts.filter((a) => a.alias.includes(q) || accountName(a).toLowerCase().includes(q)) : accounts;
    return [...list].sort((a, b) => accountName(a).localeCompare(accountName(b)));
  }, [accounts, filter]);

  function sel(key: string): Sel {
    return sels[key] ?? defaultSel(state, key);
  }

  /**
   * Pins a role to a mode for this service.
   *
   * Writes both the service-wide preference and the per-env override: the
   * preference is what makes the mode appear in the pills at all (they are
   * derived from `account.roles`), and the override is what wins at engage
   * time on this specific env, where the right role can differ.
   */
  function pickRole(account: Account, env: Env, mode: Mode, role: string) {
    const found = targetForEnv(account, env);
    if (!found) return;
    onSaveAccount({
      ...account,
      roles: { ...account.roles, [mode]: role },
      environments: {
        ...account.environments,
        [found.env]: {
          ...found.target,
          roleOverrides: { ...found.target.roleOverrides, [mode]: role },
        },
      },
    });
  }

  // First run (no accounts) or explicit re-scan → the discovery flow.
  if (accounts.length === 0 || rescanning) {
    return (
      <DiscoveryHero
        org={org}
        needsLogin={needsLogin}
        onLogin={onLogin}
        onImported={(a) => {
          onImported(a);
          setRescanning(false);
        }}
        onSessionMaybeRefreshed={onSessionMaybeRefreshed}
        autoStart={rescanning}
        onCancel={rescanning ? () => setRescanning(false) : undefined}
      />
    );
  }

  return (
    <div className="drawer-stack">
      <EngageFeedback eng={eng} />

      <div className="catalog-toolbar">
        <input
          className="catalog-filter"
          placeholder="Type to find a service…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <button
          className="label hover-glow"
          style={{ color: "var(--c-cyan)" }}
          onClick={() => setRescanning(true)}
          title="Scan the org again and merge updates"
          data-tour="services-rescan"
        >
          ↻ RE-SCAN
        </button>
      </div>

      <div className="catalog-rows" data-tour="service-rows">
        {filtered.map((a) => {
          const key = `service:${a.alias}`;
          const envs = Object.keys(a.environments) as Env[];
          const modes = Object.keys(a.roles) as Mode[];
          const s = clampSel(sel(key), envs, modes);
          const standalone = envs.length === 1 && envs[0] === "global";
          const engaged = state.engaged[a.alias];
          const isOpen = expanded === a.alias;
          const isPrdAdmin = !standalone && s.env === "prd" && s.mode === "admin";
          // What engage will actually resolve to, mirroring the backend, so
          // the UI never offers a button that is certain to fail.
          const resolution = resolveEngage(a, s.env, s.mode);
          const rolesHere = availableRolesFor(a, s.env);
          return (
            <Slab key={a.alias} cut={4} className="catalog-row">
              <div className="catalog-row-head">
                <button className="discovery-service-name hover-glow" onClick={() => setExpanded(isOpen ? null : a.alias)}>
                  <span className="service-display-name">{accountName(a)}</span>
                  <div className="env-chips">
                    {standalone ? (
                      <span className="label env-chip">GLOBAL</span>
                    ) : (
                      ENVS.filter((e) => envs.includes(e)).map((e) => (
                        <span key={e} className="label env-chip">
                          {ENV_LABELS[e]}
                        </span>
                      ))
                    )}
                  </div>
                  {engaged && (
                    <span className="label" style={{ color: engaged.env === "prd" ? "var(--c-magenta)" : "var(--c-lime)" }}>
                      ● {ENV_LABELS[engaged.env]}/{modeMeta(engaged.mode).label}
                    </span>
                  )}
                  <span className="label" style={{ color: "var(--c-dim)" }}>
                    <span className="chev">{isOpen ? "▾" : "▸"}</span>
                  </span>
                </button>
              </div>
              {isOpen && (
                <div className="catalog-row-detail">
                  <AliasEditor
                    key={a.alias}
                    alias={a.alias}
                    onRenamed={async (next) => {
                      const out = await renameAccount(a.alias, next);
                      onImported(out.accounts);
                      onStateChange(out.state);
                      setExpanded(next);
                    }}
                  />
                  <div className="catalog-row-controls">
                    <SelPills
                      envs={standalone ? [] : envs}
                      modes={modes}
                      sel={s}
                      onChange={(v) => setSels((prev) => ({ ...prev, [key]: v }))}
                    />

                    <div className="role-line">
                      <span className="label" style={{ color: "var(--c-dim)" }}>
                        ROLE
                      </span>
                      {resolution.ok ? (
                        <span className="role-effective">
                          {resolution.role}
                          {resolution.fellBackFrom && (
                            <span className="label" style={{ color: "var(--c-yellow)", marginLeft: 8 }}>
                              ↓ {modeMeta(resolution.mode).label}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="role-effective" style={{ color: "var(--c-yellow)" }}>
                          {resolution.reason}
                        </span>
                      )}
                    </div>

                    {rolesHere.length > 0 && (!resolution.ok || rolesHere.length > 1) && (
                      <div className="role-picker">
                        <span className="label" style={{ color: "var(--c-dim)" }}>
                          USE FOR {modeMeta(s.mode).label}
                        </span>
                        {rolesHere.map((r) => {
                          const active = resolution.ok && resolution.role === r;
                          return (
                            <button
                              key={r}
                              className="role-cell-item role-radio hover-glow"
                              style={{ color: active ? modeMeta(s.mode).color : "var(--c-dim)" }}
                              title={`Use ${r} when engaging ${modeMeta(s.mode).label}`}
                              onClick={() => pickRole(a, s.env, s.mode, r)}
                            >
                              {active ? "◉" : "○"} {r}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <HoldButton
                      label={standalone ? `ENGAGE ${modeMeta(s.mode).label}` : `ENGAGE ${ENV_LABELS[s.env]}/${modeMeta(s.mode).label}`}
                      holdLabel={`HOLD — ADMIN → ${ENV_LABELS[s.env]}`}
                      color={!standalone && s.env === "prd" ? "var(--c-magenta)" : modeMeta(s.mode).color}
                      requireHold={isPrdAdmin}
                      disabled={eng.busy || !resolution.ok}
                      onConfirm={() =>
                        // Re-engaging THIS service from its own row is
                        // unambiguous intent — skip the repoint gate (it
                        // exists for cross-project side effects, and a
                        // single-alias engage can only "collide" with
                        // itself).
                        void eng.run({
                          orgName: org.name,
                          aliases: [a.alias],
                          env: s.env,
                          mode: s.mode,
                          acknowledgeCollisions: true,
                        })
                      }
                      className="catalog-engage"
                    />
                  </div>
                </div>
              )}
            </Slab>
          );
        })}
      </div>
    </div>
  );
}
