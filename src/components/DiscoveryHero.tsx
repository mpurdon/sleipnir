import { useEffect, useMemo, useRef, useState } from "react";
import type { Account, Env, GroupedDiscovery, Mode, Org, ProposedService } from "../lib/types";
import { classifyRole, ENV_LABELS, envRank, MODES, sortEnvs } from "../lib/constants";
import { discoverGrouped, importAccounts, onDiscoverProgress } from "../lib/tauri";
import { formatError } from "../lib/errors";
import { SectionRule, SegmentedMeter, Slab } from "../theme";

type Phase =
  | { kind: "idle" }
  | { kind: "scanning"; done: number; total: number }
  | { kind: "review"; result: GroupedDiscovery }
  | { kind: "importing" }
  | { kind: "error"; message: string };

function envChips(service: ProposedService) {
  const envs = sortEnvs(Object.keys(service.account.environments) as Env[]);
  return envs.map((e) => (
    <span key={e} className="label env-chip">
      {ENV_LABELS[e]}
    </span>
  ));
}

/** Per-service pick state: env → mode → chosen role. */
export type EnvRolePicks = Partial<Record<Env, Partial<Record<Mode, string>>>>;

function ServiceRow({
  service,
  checked,
  onToggle,
  picks,
  onPickRole,
  resolved,
  onToggleResolved,
}: {
  service: ProposedService;
  checked: boolean;
  onToggle: () => void;
  picks: EnvRolePicks;
  onPickRole: (env: Env, mode: Mode, role: string) => void;
  /** Review bookkeeping: the user has addressed this row's role picks. */
  resolved: boolean;
  onToggleResolved: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const account = service.account;
  const needsPick = service.roleChoices.length > 0;

  return (
    <Slab cut={5} className="discovery-service-row">
      <div className="discovery-service-head">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <button className="discovery-service-name hover-glow" onClick={() => setExpanded((e) => !e)}>
          <span className="service-display-name">{service.displayName}</span>
          <span className="label service-slug">{account.alias}</span>
          <div className="env-chips">{envChips(service)}</div>
        </button>
        {needsPick && (
          <button
            className="label hover-glow resolve-badge"
            style={{ color: resolved ? "var(--c-lime)" : "var(--c-yellow)" }}
            title={resolved ? "Mark as still needing review" : "Mark as reviewed/OK (picking a role also resolves it)"}
            onClick={onToggleResolved}
          >
            {resolved ? "✓ RESOLVED" : "⚠ PICK ROLE"}
          </button>
        )}
        <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={() => setExpanded((e) => !e)}>
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {expanded && (
        <div className="discovery-service-detail">
          {service.note && (
            <div className="label" style={{ color: "var(--c-dim)" }}>
              {service.note}
            </div>
          )}
          <EnvTable service={service} picks={picks} onPickRole={onPickRole} />
        </div>
      )}
    </Slab>
  );
}

/**
 * The expanded detail as a matrix: one row per environment, one column
 * per mode. The role that will actually be used on THAT environment
 * lights up in the mode's color; alternates render dim and are clickable
 * per env — picking SSTPowerUserAccess on SBX doesn't touch STG/PRD
 * (where it may not even exist). Unmapped roles collect in OTHER.
 */
function EnvTable({
  service,
  picks,
  onPickRole,
}: {
  service: ProposedService;
  picks: EnvRolePicks;
  onPickRole: (env: Env, mode: Mode, role: string) => void;
}) {
  const account = service.account;
  const entries = (
    Object.entries(account.environments) as [Env, { accountId: string; accountName?: string; availableRoles?: string[] }][]
  ).sort(([a], [b]) => envRank(a) - envRank(b));

  const hasOther = entries.some(([, t]) => (t.availableRoles ?? []).some((r) => classifyRole(r) === null));
  const columns = `52px minmax(140px, 1fr) 100px repeat(3, minmax(118px, 1fr))${hasOther ? " minmax(110px, 0.9fr)" : ""}`;

  /** Mirrors engage-time resolution: explicit env pick → service-wide
   * preference if available on this env → shortest classified fallback. */
  const usedRole = (env: Env, forMode: string[], m: Mode): string | undefined => {
    const picked = picks[env]?.[m];
    if (picked && forMode.includes(picked)) return picked;
    const pref = account.roles[m];
    if (pref && forMode.includes(pref)) return pref;
    return [...forMode].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  };

  return (
    <div className="env-table" style={{ gridTemplateColumns: columns }}>
      <span />
      <span className="label env-table-head">Account</span>
      <span className="label env-table-head">ID</span>
      {MODES.map((m) => (
        <span key={m.key} className="label env-table-head" style={{ color: m.color }}>
          {m.label}
        </span>
      ))}
      {hasOther && <span className="label env-table-head">OTHER</span>}

      {entries.map(([env, target]) => {
        const roles = target.availableRoles ?? [];
        const others = roles.filter((r) => classifyRole(r) === null);
        return (
          <div key={env} className="env-table-cells">
            <span className="label env-chip">{ENV_LABELS[env]}</span>
            <span className="label env-table-account">{target.accountName}</span>
            <span className="label" style={{ color: "var(--c-dim)" }}>
              {target.accountId}
            </span>
            {MODES.map((m) => {
              const candidates = roles.filter((r) => classifyRole(r) === m.key);
              const used = usedRole(env, candidates, m.key);
              // Stable order: the role in use first, then alphabetical —
              // AWS returns them in arbitrary order.
              const forMode = [...candidates].sort((a, b) =>
                a === used ? -1 : b === used ? 1 : a.localeCompare(b),
              );
              const pickable = candidates.length > 1;
              return (
                <span key={m.key} className="role-cell">
                  {forMode.length === 0 && <span className="role-cell-item role-cell-none">—</span>}
                  {forMode.map((r) => {
                    const isUsed = r === used;
                    if (!pickable) {
                      return (
                        <span key={r} className="role-cell-item" style={{ color: isUsed ? m.color : "var(--c-dim)" }}>
                          {r}
                        </span>
                      );
                    }
                    return (
                      <button
                        key={r}
                        className="role-cell-item role-radio hover-glow"
                        style={{ color: isUsed ? m.color : "var(--c-dim)" }}
                        title={
                          isUsed
                            ? `${m.label} on ${ENV_LABELS[env]} uses ${r}`
                            : `Use ${r} for ${m.label} on ${ENV_LABELS[env]} only`
                        }
                        onClick={() => onPickRole(env, m.key, r)}
                      >
                        {isUsed ? "◉" : "○"} {r}
                      </button>
                    );
                  })}
                </span>
              );
            })}
            {hasOther && (
              <span className="role-cell">
                {others.map((r) => (
                  <span key={r} className="role-cell-item" style={{ color: "var(--c-dim)", opacity: 0.7 }}>
                    {r}
                  </span>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DiscoveryHero({
  org,
  onImported,
  needsLogin,
  onLogin,
  onSessionMaybeRefreshed,
  autoStart,
  onCancel,
}: {
  org: Org;
  onImported: (accounts: Account[]) => void;
  needsLogin: boolean;
  onLogin: () => void;
  /** Scans chain a silent token refresh backend-side — let the app re-read
   * org statuses afterwards so the sidebar countdown stays truthful. */
  onSessionMaybeRefreshed?: () => void;
  /** Re-scan mode: skip the idle hero and start scanning immediately. */
  autoStart?: boolean;
  /** Present in re-scan mode — lets the user back out to Home. */
  onCancel?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [rolePicks, setRolePicks] = useState<Record<string, EnvRolePicks>>({});
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [showStandalone, setShowStandalone] = useState(false);
  const unlisten = useRef<(() => void) | null>(null);
  const wasNeedingLogin = useRef(needsLogin);

  // Re-scan mode arrives with intent already declared — start immediately
  // (the backend chains a silent token refresh / login if needed).
  useEffect(() => {
    if (autoStart) void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Goal-gradient: when a login completes while this hero is showing,
  // carry the momentum straight into the scan instead of stopping at a
  // second button.
  useEffect(() => {
    if (wasNeedingLogin.current && !needsLogin && phase.kind === "idle") {
      void scan();
    }
    wasNeedingLogin.current = needsLogin;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsLogin]);

  useEffect(() => {
    onDiscoverProgress((p) => {
      setPhase((prev) => (prev.kind === "scanning" ? { kind: "scanning", done: p.done, total: p.total } : prev));
    }).then((u) => {
      unlisten.current = u;
    });
    return () => unlisten.current?.();
  }, []);

  async function scan() {
    setPhase({ kind: "scanning", done: 0, total: 0 });
    try {
      const result = await discoverGrouped(org.name);
      setExcluded(new Set());
      setRolePicks({});
      setResolved(new Set());
      setPhase({ kind: "review", result });
    } catch (e) {
      setPhase({ kind: "error", message: formatError(e) });
    } finally {
      onSessionMaybeRefreshed?.();
    }
  }

  const selectedCount = useMemo(() => {
    if (phase.kind !== "review") return 0;
    const all = [...phase.result.services, ...phase.result.standalone];
    return all.filter((s) => !excluded.has(s.account.alias)).length;
  }, [phase, excluded]);

  function pickRole(alias: string, env: Env, mode: Mode, role: string) {
    setRolePicks((prev) => ({
      ...prev,
      [alias]: { ...prev[alias], [env]: { ...prev[alias]?.[env], [mode]: role } },
    }));
    // Making a pick IS addressing the row — mark it resolved.
    setResolved((prev) => new Set(prev).add(alias));
  }

  function toggleResolved(alias: string) {
    setResolved((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  async function doImport() {
    if (phase.kind !== "review") return;
    const all = [...phase.result.services, ...phase.result.standalone];
    const accounts = all
      .filter((s) => !excluded.has(s.account.alias))
      .map((s) => {
        const envPicks = rolePicks[s.account.alias];
        if (!envPicks) return s.account;
        // Clicked picks land as per-env roleOverrides on the env targets.
        const environments = Object.fromEntries(
          (Object.entries(s.account.environments) as [Env, (typeof s.account.environments)[Env] & object][]).map(
            ([env, target]) => [
              env,
              envPicks[env] ? { ...target, roleOverrides: { ...target.roleOverrides, ...envPicks[env] } } : target,
            ],
          ),
        );
        return { ...s.account, environments };
      });
    setPhase({ kind: "importing" });
    try {
      // The command returns the FULL updated account list, not just the
      // imported subset — hand that up so app state replaces wholesale.
      onImported(await importAccounts(accounts));
    } catch (e) {
      setPhase({ kind: "error", message: formatError(e) });
    }
  }

  function toggle(alias: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  if (phase.kind === "idle" || phase.kind === "error") {
    return (
      <div className="discovery-hero">
        {onCancel && (
          <button className="back-link label hover-glow" onClick={onCancel} style={{ color: "var(--c-dim)" }}>
            ‹ HOME
          </button>
        )}
        <h1 className="project-title">Wire up {org.name}</h1>
        <p className="discovery-hero-copy">
          Sleipnir scans your AWS organization and wires accounts into services automatically from their naming
          convention — no manual tagging.
        </p>
        {phase.kind === "error" && (
          <Slab tint="var(--c-magenta)" cut={5} className="discovery-error-box">
            {phase.message}
          </Slab>
        )}
        {needsLogin ? (
          <button
            className="engage-btn hover-glow neon"
            style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
            onClick={onLogin}
            data-tour="discovery-scan"
          >
            LOG IN TO {org.name.toUpperCase()}
          </button>
        ) : (
          <button
            className="engage-btn hover-glow neon"
            style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
            onClick={scan}
            data-tour="discovery-scan"
          >
            SCAN {org.name.toUpperCase()}
          </button>
        )}
      </div>
    );
  }

  if (phase.kind === "scanning" || phase.kind === "importing") {
    const fraction = phase.kind === "scanning" && phase.total > 0 ? phase.done / phase.total : 0;
    return (
      <div className="discovery-hero">
        <h1 className="project-title">{phase.kind === "importing" ? "Importing…" : `Scanning ${org.name}`}</h1>
        {phase.kind === "scanning" && (
          <>
            <SegmentedMeter fraction={fraction} color="var(--c-cyan)" />
            <div className="label" style={{ color: "var(--c-dim)" }}>
              {phase.total > 0 ? `${phase.done} / ${phase.total} ACCOUNTS SCANNED` : "LISTING ACCOUNTS…"}
            </div>
          </>
        )}
      </div>
    );
  }

  // review
  const { result } = phase;
  const needingPick = [...result.services, ...result.standalone].filter((s) => s.roleChoices.length > 0);
  const resolvedCount = needingPick.filter((s) => resolved.has(s.account.alias)).length;
  return (
    <div className="discovery-review">
      <div className="discovery-review-head">
        <h1 className="project-title">
          {result.totalAccounts} accounts → {result.services.length} services + {result.standalone.length} standalone
        </h1>
        {needingPick.length > 0 && (
          <span
            className="label"
            style={{ color: resolvedCount === needingPick.length ? "var(--c-lime)" : "var(--c-yellow)" }}
          >
            {resolvedCount}/{needingPick.length} PICKS RESOLVED
          </span>
        )}
        <button className="label hover-glow" style={{ color: "var(--c-cyan)" }} onClick={scan} title="Run the scan again">
          ↻ RESCAN
        </button>
        {onCancel && (
          <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={onCancel}>
            CANCEL
          </button>
        )}
      </div>
      <p className="discovery-hero-copy">
        Each row is one service; the grey chips are the environments found for it and the small name is the AWS
        profile you'll use in terminals. Expand any row to see the underlying accounts and every role available on
        each. <span style={{ color: "var(--c-yellow)" }}>⚠ PICK ROLE</span> means two roles map to the same mode —
        a sensible default is pre-picked, expand to click the other one if it's the right choice. Uncheck what you
        don't want, then import.
      </p>

      <SectionRule title={`Services (${result.services.length})`} />
      <div className="discovery-rows" data-tour="discovery-rows">
        {result.services.map((s) => (
          <ServiceRow
            key={s.account.alias}
            service={s}
            checked={!excluded.has(s.account.alias)}
            onToggle={() => toggle(s.account.alias)}
            picks={rolePicks[s.account.alias] ?? {}}
            onPickRole={(env, mode, role) => pickRole(s.account.alias, env, mode, role)}
            resolved={resolved.has(s.account.alias)}
            onToggleResolved={() => toggleResolved(s.account.alias)}
          />
        ))}
      </div>

      <button className="label hover-glow" style={{ color: "var(--c-cyan)", alignSelf: "flex-start" }} onClick={() => setShowStandalone((v) => !v)}>
        {showStandalone ? "▾" : "▸"} STANDALONE ACCOUNTS ({result.standalone.length})
      </button>
      {showStandalone && (
        <div className="discovery-rows">
          {result.standalone.map((s) => (
            <ServiceRow
              key={s.account.alias}
              service={s}
              checked={!excluded.has(s.account.alias)}
              onToggle={() => toggle(s.account.alias)}
              picks={rolePicks[s.account.alias] ?? {}}
              onPickRole={(env, mode, role) => pickRole(s.account.alias, env, mode, role)}
              resolved={resolved.has(s.account.alias)}
              onToggleResolved={() => toggleResolved(s.account.alias)}
            />
          ))}
        </div>
      )}

      <button
        className="engage-btn hover-glow neon"
        style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
        disabled={selectedCount === 0}
        onClick={doImport}
      >
        IMPORT {selectedCount} SELECTED
      </button>
    </div>
  );
}
