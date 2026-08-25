import { useMemo, useState } from "react";
import type { Account, AppState, Env, Mode, Org } from "../lib/types";
import { accountName, ENVS, ENV_LABELS } from "../lib/constants";
import { useEngage } from "../lib/useEngage";
import { defaultSel, EngageFeedback, modeMeta, SelPills, type Sel } from "./engageUi";
import { DiscoveryHero } from "./DiscoveryHero";
import { HoldButton } from "./HoldButton";
import { Slab } from "../theme";

export function ServicesDrawer({
  org,
  accounts,
  state,
  needsLogin,
  onLogin,
  onStateChange,
  onImported,
  onSessionMaybeRefreshed,
}: {
  org: Org;
  accounts: Account[];
  state: AppState;
  needsLogin: boolean;
  onLogin: () => void;
  onStateChange: (s: AppState) => void;
  onImported: (accounts: Account[]) => void;
  onSessionMaybeRefreshed?: () => void;
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
        <button className="label hover-glow" style={{ color: "var(--c-cyan)" }} onClick={() => setRescanning(true)} title="Scan the org again and merge updates">
          ↻ RE-SCAN
        </button>
      </div>

      <div className="catalog-rows">
        {filtered.map((a) => {
          const key = `service:${a.alias}`;
          const s = sel(key);
          const envs = Object.keys(a.environments) as Env[];
          const modes = Object.keys(a.roles) as Mode[];
          const standalone = envs.length === 1 && envs[0] === "global";
          const engaged = state.engaged[a.alias];
          const isOpen = expanded === a.alias;
          const isPrdAdmin = !standalone && s.env === "prd" && s.mode === "admin";
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
                    {isOpen ? "▾" : "▸"}
                  </span>
                </button>
              </div>
              {isOpen && (
                <div className="catalog-row-detail">
                  <span className="label service-slug" title="AWS profile name">
                    {a.alias}
                  </span>
                  <SelPills
                    envs={standalone ? [] : envs}
                    modes={modes}
                    sel={s}
                    onChange={(v) => setSels((prev) => ({ ...prev, [key]: v }))}
                  />
                  <HoldButton
                    label={standalone ? `ENGAGE ${modeMeta(s.mode).label}` : `ENGAGE ${ENV_LABELS[s.env]}/${modeMeta(s.mode).label}`}
                    holdLabel={`HOLD — ADMIN → ${ENV_LABELS[s.env]}`}
                    color={!standalone && s.env === "prd" ? "var(--c-magenta)" : modeMeta(s.mode).color}
                    requireHold={isPrdAdmin}
                    disabled={eng.busy}
                    onConfirm={() => void eng.run({ orgName: org.name, aliases: [a.alias], env: s.env, mode: s.mode })}
                    className="catalog-engage"
                  />
                </div>
              )}
            </Slab>
          );
        })}
      </div>
    </div>
  );
}
