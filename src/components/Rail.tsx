import { useEffect, useState } from "react";
import type { AppState, EngagedProfile, Org } from "../lib/types";
import type { LoginProgress } from "../lib/tauri";
import { ENV_LABELS, MODES } from "../lib/constants";
import { closeWindow, minimizeWindow } from "../lib/drawerWindow";
import { SectionRule, Slab } from "../theme";
import sleipnirWordmark from "../assets/sleipnir-wordmark.png";

function lampColor(org: Org, loggingIn: boolean): string {
  if (loggingIn) return "var(--c-yellow)";
  if (!org.tokenExpiresAt) return "var(--c-magenta)";
  const msLeft = new Date(org.tokenExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return "var(--c-magenta)";
  if (msLeft < 30 * 60_000) return "var(--c-yellow)";
  return "var(--c-lime)";
}

function lampLabel(org: Org): string {
  if (!org.tokenExpiresAt) return "NOT LOGGED IN";
  const msLeft = new Date(org.tokenExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return "EXPIRED";
  const hrs = Math.floor(msLeft / 3_600_000);
  const mins = Math.floor((msLeft % 3_600_000) / 60_000);
  return hrs > 0 ? `${hrs}H ${mins}M` : `${mins}M`;
}

function progressLabel(p: LoginProgress): string {
  switch (p.stage) {
    case "registering":
      return "REGISTERING…";
    case "awaitingBrowserApproval":
      return "APPROVE IN BROWSER…";
    case "polling":
      return "WAITING…";
    case "done":
      return "DONE";
  }
}

/**
 * The always-visible compact column: orgs, live engaged status grouped by
 * project, and the drawer menu. The wordmark header doubles as the
 * window-drag handle (the native title bar is gone).
 */
export function Rail({
  orgs,
  activeOrg,
  activeLoginName,
  activeLoginProgress,
  state,
  projectCount,
  serviceCount,
  activeDrawer,
  onSelectOrg,
  onAddOrg,
  onOpenProjects,
  onOpenServices,
  onOpenSettings,
  onDisengage,
  onDisengageAll,
}: {
  orgs: Org[];
  activeOrg: string;
  activeLoginName: string | null;
  activeLoginProgress: LoginProgress | null;
  state: AppState;
  projectCount: number;
  serviceCount: number;
  activeDrawer: string | null;
  onSelectOrg: (name: string) => void;
  onAddOrg: () => void;
  onOpenProjects: () => void;
  onOpenServices: () => void;
  onOpenSettings: () => void;
  onDisengage: (profiles: string[]) => void;
  onDisengageAll: () => void;
}) {
  // Tick so countdowns/lamps stay honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const engaged = Object.entries(state.engaged);
  // Group engaged profiles into project containers; ad-hoc engages get
  // their own bucket.
  const groups = new Map<string, [string, EngagedProfile][]>();
  for (const [alias, e] of engaged) {
    const key = e.project ?? "AD-HOC";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push([alias, e]);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => (a === "AD-HOC" ? 1 : b === "AD-HOC" ? -1 : a.localeCompare(b)));

  return (
    <aside className="rail">
      <header className="rail-header" data-tauri-drag-region>
        <img src={sleipnirWordmark} alt="Sleipnir" className="rail-wordmark" data-tauri-drag-region draggable={false} />
        <div className="rail-window-controls">
          <button className="win-btn hover-glow" title="Minimize" onClick={() => void minimizeWindow()}>
            –
          </button>
          <button className="win-btn hover-glow" title="Close" onClick={() => void closeWindow()}>
            ×
          </button>
        </div>
      </header>

      <SectionRule title="Orgs" />
      <div className="org-list">
        {orgs.map((org) => {
          const loggingIn = org.name === activeLoginName;
          const color = lampColor(org, loggingIn);
          const active = org.name === activeOrg;
          return (
            <button
              key={org.name}
              className={`org-row hover-glow${active ? " org-row-active" : ""}`}
              onClick={() => onSelectOrg(org.name)}
              title="Open org settings"
            >
              <span
                className={`org-lamp${loggingIn ? " org-lamp-pulse" : ""}`}
                style={{ background: color, boxShadow: `0 0 4px ${color}` }}
              />
              <span className="org-name">{org.name}</span>
              <span className="label org-status" style={{ color }}>
                {loggingIn && activeLoginProgress ? progressLabel(activeLoginProgress) : lampLabel(org)}
              </span>
            </button>
          );
        })}
        <button className="label hover-glow rail-add-org" onClick={onAddOrg}>
          + ADD ORG
        </button>
      </div>

      <SectionRule title="Engaged" />
      {engaged.length === 0 ? (
        <div className="label rail-empty">NOTHING ENGAGED</div>
      ) : (
        <div className="rail-engaged">
          {sortedGroups.map(([group, entries]) => (
            <Slab key={group} cut={5} tint={group === "AD-HOC" ? "var(--c-edge)" : "var(--c-lime)"} className="rail-group">
              <div className="rail-group-head">
                <span className="label" style={{ color: group === "AD-HOC" ? "var(--c-dim)" : "var(--c-lime)" }}>
                  {group}
                </span>
                <button
                  className="label hover-glow"
                  style={{ color: "var(--c-dim)" }}
                  title="Disengage this group"
                  onClick={() => onDisengage(entries.map(([alias]) => alias))}
                >
                  ×
                </button>
              </div>
              {entries
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([alias, e]) => {
                  const mode = MODES.find((m) => m.key === e.mode)!;
                  const isPrd = e.env === "prd";
                  return (
                    <div key={alias} className="rail-chip">
                      <span className="rail-chip-alias">{alias}</span>
                      <span className="label" style={{ color: isPrd ? "var(--c-magenta)" : mode.color }}>
                        {ENV_LABELS[e.env]}/{mode.label}
                      </span>
                      <button className="label hover-glow rail-chip-x" title={`Disengage ${alias}`} onClick={() => onDisengage([alias])}>
                        ×
                      </button>
                    </div>
                  );
                })}
            </Slab>
          ))}
          <button className="label hover-glow" style={{ color: "var(--c-magenta)", alignSelf: "flex-start" }} onClick={onDisengageAll}>
            DISENGAGE ALL
          </button>
        </div>
      )}

      <div className="rail-menu">
        <button
          className={`rail-menu-btn hover-glow${activeDrawer === "projects" ? " rail-menu-active" : ""}`}
          onClick={onOpenProjects}
        >
          <span>PROJECTS</span>
          <span className="label" style={{ color: "var(--c-dim)" }}>
            {projectCount} ▸
          </span>
        </button>
        <button
          className={`rail-menu-btn hover-glow${activeDrawer === "services" ? " rail-menu-active" : ""}`}
          onClick={onOpenServices}
        >
          <span>SERVICES</span>
          <span className="label" style={{ color: "var(--c-dim)" }}>
            {serviceCount} ▸
          </span>
        </button>
      </div>

      <div className="sidebar-footer">
        <button className="settings-btn hover-glow" onClick={onOpenSettings}>
          ⚙ SETTINGS
        </button>
      </div>
    </aside>
  );
}
