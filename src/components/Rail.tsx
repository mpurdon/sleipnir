import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AppState, EngagedProfile, Org } from "../lib/types";
import { testProfile, type LoginProgress, type ProfileTest } from "../lib/tauri";
import { ENV_LABELS, isSessionAlive, MODES, sessionMsLeft } from "../lib/constants";
import { formatError } from "../lib/errors";
import { closeWindow, minimizeWindow } from "../lib/drawerWindow";
import { SectionRule, Slab } from "../theme";
import sleipnirWordmark from "../assets/sleipnir-wordmark.png";
import disconnectIcon from "../assets/disconnect.png";
import closeIcon from "../assets/close.png";

function lampColor(org: Org, loggingIn: boolean): string {
  if (loggingIn) return "var(--c-yellow)";
  const msLeft = sessionMsLeft(org);
  if (msLeft <= 0) return "var(--c-magenta)";
  if (msLeft < 30 * 60_000) return "var(--c-yellow)";
  return "var(--c-lime)";
}

function lampLabel(org: Org): string {
  // A dead session's label is a call to action — clicking the row starts
  // the login directly, no drawer detour.
  const msLeft = sessionMsLeft(org);
  if (msLeft <= 0) return "LOG IN ▸";
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

/** Result overlay for a live `aws sts get-caller-identity` probe. */
function TestModal({
  alias,
  result,
  onClose,
}: {
  alias: string;
  result: ProfileTest | "running" | { error: string };
  onClose: () => void;
}) {
  const running = result === "running";
  const failed = typeof result === "object" && ("error" in result || !result.ok);
  const test = typeof result === "object" && "ok" in result ? result : null;
  const color = running ? "var(--c-cyan)" : failed ? "var(--c-magenta)" : "var(--c-lime)";
  // Portal to <body>: the rail and drawer each form stacking contexts (and
  // the rail clips overflow for the frozen header), so an in-tree overlay
  // gets buried/clipped when a drawer is open.
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <Slab tint={color} cut={6} className="test-modal" style={{ minWidth: 300 }}>
        <div onClick={(e) => e.stopPropagation()} className="test-modal-inner">
          <div className="rail-group-head">
            <span className="label" style={{ color }}>
              {running ? "⚡ TESTING" : failed ? "✗ FAILED" : "✓ CONNECTED"} · {alias}
            </span>
            <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={onClose}>
              CLOSE
            </button>
          </div>

          {running && <div className="label" style={{ color: "var(--c-dim)" }}>RUNNING aws sts get-caller-identity…</div>}

          {test && test.ok && (
            <div className="test-modal-rows">
              <div className="test-row">
                <span className="label">ACCOUNT</span>
                <span className="test-value">{test.account}</span>
              </div>
              <div className="test-row">
                <span className="label">ARN</span>
                <span className="test-value">{test.arn}</span>
              </div>
              <div className="test-row">
                <span className="label">USER ID</span>
                <span className="test-value">{test.userId}</span>
              </div>
              <div className="test-row">
                <span className="label">TIME</span>
                <span className="test-value">{test.ms}ms</span>
              </div>
            </div>
          )}

          {typeof result === "object" && "error" in result && (
            <div className="test-value" style={{ color: "var(--c-magenta)" }}>{result.error}</div>
          )}
          {test && !test.ok && (
            <div className="test-value" style={{ color: "var(--c-magenta)" }}>
              {test.message} <span style={{ color: "var(--c-dim)" }}>({test.ms}ms)</span>
            </div>
          )}
        </div>
      </Slab>
    </div>,
    document.body,
  );
}

/** One engaged profile chip: click to reveal copyable connection details. */
function EngagedChip({
  alias,
  entry,
  onDisengage,
}: {
  alias: string;
  entry: EngagedProfile;
  onDisengage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [test, setTest] = useState<ProfileTest | "running" | { error: string } | null>(null);
  const mode = MODES.find((m) => m.key === entry.mode)!;
  const isPrd = entry.env === "prd";

  async function runTest() {
    setTest("running");
    try {
      setTest(await testProfile(alias));
    } catch (e) {
      setTest({ error: formatError(e) });
    }
  }

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  const fields: [string, string][] = [
    ["profile", alias],
    ["account", entry.accountId],
    ["region", entry.region],
    ["role", entry.roleName],
  ];

  return (
    <div className="rail-chip-block" data-tour="rail-chip">
      <div className="rail-chip">
        <button className="rail-chip-alias hover-glow" onClick={() => setOpen((o) => !o)} title="Show copyable details">
          {alias}
        </button>
        <span className="label" style={{ color: isPrd ? "var(--c-magenta)" : mode.color }}>
          {ENV_LABELS[entry.env]}/{mode.label}
        </span>
        <button className="rail-disc-btn hover-glow" title={`Disengage ${alias}`} onClick={onDisengage}>
          <img src={disconnectIcon} alt="" className="disc-icon" draggable={false} />
        </button>
      </div>
      {open && (
        <div className="rail-chip-copy">
          {fields.map(([k, v]) => (
            <button
              key={k}
              className="rail-copy-btn hover-glow"
              title={`Copy ${v}`}
              onClick={() => void copy(k, v)}
            >
              <span className="label" style={{ color: copied === k ? "var(--c-lime)" : "var(--c-dim)" }}>
                {copied === k ? "✓ COPIED" : k}
              </span>
              <span className="rail-copy-value">{v}</span>
            </button>
          ))}
          <button className="label hover-glow test-btn" onClick={() => void runTest()} title="Run aws sts get-caller-identity with this profile">
            ⚡ TEST CONNECTION
          </button>
        </div>
      )}
      {test !== null && <TestModal alias={alias} result={test} onClose={() => setTest(null)} />}
    </div>
  );
}

/**
 * The always-visible compact column: orgs, the drawer menu, then live
 * engaged status grouped by project (below the menu so it can grow
 * without pushing the primary navigation around). The wordmark header
 * doubles as the window-drag handle.
 */
export function Rail({
  devBuild,
  orgs,
  activeOrg,
  activeLoginName,
  activeLoginProgress,
  state,
  projectCount,
  serviceCount,
  activeDrawer,
  highlightServices,
  onSelectOrg,
  onConfigureOrg,
  onAddOrg,
  onOpenProjects,
  onOpenServices,
  onOpenSettings,
  onOpenHelp,
  onDisengage,
  onDisengageAll,
}: {
  /** `tauri dev` build — badge the header so a dev window is never mistaken
   * for the installed app. */
  devBuild: boolean;
  orgs: Org[];
  activeOrg: string;
  activeLoginName: string | null;
  activeLoginProgress: LoginProgress | null;
  state: AppState;
  projectCount: number;
  serviceCount: number;
  activeDrawer: string | null;
  /** Pulses the SERVICES menu item — set right after adding an org, when
   * scanning is the natural next step. */
  highlightServices: boolean;
  /** Row click: just make this org active for projects/services. */
  onSelectOrg: (name: string) => void;
  /** Gear click: open the org's settings drawer (also selects it). */
  onConfigureOrg: (name: string) => void;
  onAddOrg: () => void;
  onOpenProjects: () => void;
  onOpenServices: () => void;
  onOpenSettings: () => void;
  /** Opens Settings on the help tab — guided tours and the docs link. */
  onOpenHelp: () => void;
  onDisengage: (profiles: string[]) => void;
  onDisengageAll: () => void;
}) {
  // Tick so countdowns/lamps stay honest.
  const [, setTick] = useState(0);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const engaged = Object.entries(state.engaged);
  // Project engages get grouped containers; ad-hoc engages stand alone as
  // their own blocks — no artificial "AD-HOC" group.
  const groups = new Map<string, [string, EngagedProfile][]>();
  const adhoc: [string, EngagedProfile][] = [];
  for (const [alias, e] of engaged) {
    if (e.project) {
      if (!groups.has(e.project)) groups.set(e.project, []);
      groups.get(e.project)!.push([alias, e]);
    } else {
      adhoc.push([alias, e]);
    }
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  adhoc.sort(([a], [b]) => a.localeCompare(b));

  function toggleGroup(name: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <aside className="rail">
      <header className="rail-header" data-tauri-drag-region>
        <img src={sleipnirWordmark} alt="Sleipnir" className="rail-wordmark" data-tauri-drag-region draggable={false} />
        {devBuild && (
          <span className="label dev-badge" title="Development build — reads ~/.sleipnir-dev, not your real config">
            DEV
          </span>
        )}
        <div className="rail-window-controls">
          <button className="win-btn hover-glow" title="Minimize" onClick={() => void minimizeWindow()}>
            –
          </button>
          <button className="win-btn hover-glow" title="Close" onClick={() => void closeWindow()}>
            <img src={closeIcon} alt="" className="close-icon" draggable={false} />
          </button>
        </div>
      </header>

      <div className="rail-scroll">
      <SectionRule title="Orgs" />
      <div className="org-list" data-tour="rail-orgs">
        {orgs.map((org) => {
          const loggingIn = org.name === activeLoginName;
          const color = lampColor(org, loggingIn);
          const active = org.name === activeOrg;
          return (
            <div key={org.name} className={`org-row${active ? " org-row-active" : ""}`}>
              <button
                className="org-row-main hover-glow"
                onClick={() => onSelectOrg(org.name)}
                title={isSessionAlive(org) ? `Use ${org.name} for projects & services` : `Log in to ${org.name}`}
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
              <button className="org-gear hover-glow" title={`${org.name} settings`} onClick={() => onConfigureOrg(org.name)}>
                ⚙
              </button>
            </div>
          );
        })}
        <button className="label hover-glow rail-add-org" onClick={onAddOrg} data-tour="rail-add-org">
          + ADD ORG
        </button>
      </div>

      <div className="rail-menu">
        <button
          className={`rail-menu-btn hover-glow${activeDrawer === "projects" ? " rail-menu-active" : ""}`}
          onClick={onOpenProjects}
          data-tour="rail-projects"
        >
          <span>PROJECTS</span>
          <span className="label" style={{ color: "var(--c-dim)" }}>
            {projectCount} ▸
          </span>
        </button>
        <button
          className={`rail-menu-btn hover-glow${activeDrawer === "services" ? " rail-menu-active" : ""}${highlightServices ? " rail-menu-pulse" : ""}`}
          onClick={onOpenServices}
          data-tour="rail-services"
        >
          <span>SERVICES</span>
          <span className="label" style={{ color: "var(--c-dim)" }}>
            {serviceCount} ▸
          </span>
        </button>
      </div>

      <SectionRule title="Engaged" />
      {engaged.length === 0 ? (
        <div className="label rail-empty" data-tour="rail-engaged">NOTHING ENGAGED</div>
      ) : (
        <div className="rail-engaged" data-tour="rail-engaged">
          <button className="hover-glow rail-disengage-all" onClick={onDisengageAll} title="Disengage everything" data-tour="rail-disengage-all">
            <img src={disconnectIcon} alt="" className="disc-icon" draggable={false} />
            <span className="label" style={{ color: "var(--c-magenta)" }}>
              DISENGAGE ALL
            </span>
          </button>
          {sortedGroups.map(([group, entries]) => {
            const open = openGroups.has(group);
            const anyPrd = entries.some(([, e]) => e.env === "prd");
            return (
              <Slab key={group} cut={5} tint={anyPrd ? "var(--c-magenta)" : "var(--c-lime)"} className="rail-group">
                <div className="rail-group-head">
                  <button className="rail-group-toggle hover-glow" onClick={() => toggleGroup(group)}>
                    <span className="label" style={{ color: anyPrd ? "var(--c-magenta)" : "var(--c-lime)" }}>
                      {group}
                    </span>
                    <span className="label" style={{ color: "var(--c-dim)" }}>
                      {entries.length} {open ? "▾" : "▸"}
                    </span>
                  </button>
                  <button
                    className="rail-disc-btn hover-glow"
                    title="Disengage this group"
                    onClick={() => onDisengage(entries.map(([alias]) => alias))}
                  >
                    <img src={disconnectIcon} alt="" className="disc-icon" draggable={false} />
                  </button>
                </div>
                {open &&
                  entries
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([alias, e]) => (
                      <EngagedChip key={alias} alias={alias} entry={e} onDisengage={() => onDisengage([alias])} />
                    ))}
              </Slab>
            );
          })}
          {adhoc.map(([alias, e]) => (
            <Slab
              key={alias}
              cut={5}
              tint={e.env === "prd" ? "var(--c-magenta)" : "var(--c-edge)"}
              className="rail-group"
            >
              <EngagedChip alias={alias} entry={e} onDisengage={() => onDisengage([alias])} />
            </Slab>
          ))}
        </div>
      )}

      <div className="sidebar-footer">
        <button className="settings-btn hover-glow" onClick={onOpenSettings}>
          ⚙ SETTINGS
        </button>
        <button className="help-btn hover-glow" onClick={onOpenHelp} title="Guided tours and help docs" data-tour="rail-help">
          ?
        </button>
      </div>
      </div>
    </aside>
  );
}
