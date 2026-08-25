import { useMemo, useState } from "react";
import type { Account, AppState, Env, Mode, Org, Project } from "../lib/types";
import { ENVS, ENV_LABELS, MODES } from "../lib/constants";
import { useEngage, type RowStatus } from "../lib/useEngage";
import { HoldButton } from "./HoldButton";
import { SectionRule, SegmentedMeter, Slab } from "../theme";

function statusLabel(r: RowStatus | undefined): string {
  if (!r) return "";
  switch (r.status) {
    case "pending":
      return "PENDING";
    case "assuming":
      return "ASSUMING ROLE";
    case "done":
      return "DONE";
    case "failed":
      return `FAILED — ${r.message ?? "unknown error"}`;
  }
}

function statusColor(r: RowStatus | undefined): string {
  if (!r) return "var(--c-dim)";
  if (r.status === "failed") return "var(--c-magenta)";
  if (r.status === "done") return "var(--c-lime)";
  if (r.status === "pending") return "var(--c-dim)";
  return "var(--c-cyan)";
}

export function ProjectPanel({
  project,
  accounts,
  org,
  state,
  onStateChange,
  onBack,
}: {
  project: Project;
  accounts: Account[];
  org: Org;
  state: AppState;
  onStateChange: (s: AppState) => void;
  onBack: () => void;
}) {
  const last = state.lastEngage[`project:${project.name}`];
  const [env, setEnv] = useState<Env>(last?.env ?? "dev");
  const [mode, setMode] = useState<Mode>(last?.mode ?? "powerUser");
  const eng = useEngage(onStateChange);

  const members = useMemo(
    () => project.members.map((alias) => accounts.find((a) => a.alias === alias)).filter((a): a is Account => !!a),
    [project, accounts],
  );

  const activeMode = MODES.find((m) => m.key === mode)!;
  const isPrdAdmin = env === "prd" && mode === "admin";

  function engage() {
    void eng.run({ orgName: org.name, project: project.name, aliases: project.members, env, mode });
  }

  const rowEntries = Object.entries(eng.rows);
  const doneFraction =
    rowEntries.length > 0
      ? rowEntries.filter(([, r]) => r.status === "done" || r.status === "failed").length / rowEntries.length
      : 0;

  const lastLabel = last
    ? `LAST ENGAGED ${ENV_LABELS[last.env]}/${MODES.find((m) => m.key === last.mode)!.label} · ${new Date(last.atUnixMs).toLocaleString()}`
    : null;

  return (
    <div className="project-panel">
      <button className="back-link label hover-glow" onClick={onBack} style={{ color: "var(--c-dim)" }}>
        ‹ PROJECTS
      </button>

      <h1 className="project-title">{project.name}</h1>
      {lastLabel && (
        <div className="label" style={{ color: "var(--c-dim)" }}>
          {lastLabel}
        </div>
      )}

      <SectionRule title="Environment" />
      <div className="pill-row">
        {ENVS.map((e) => (
          <button
            key={e}
            className={`pill${env === e ? " pill-active" : ""}${e === "prd" && env === e ? " pill-prd" : ""}`}
            onClick={() => setEnv(e)}
          >
            {e.toUpperCase()}
          </button>
        ))}
      </div>

      <SectionRule title="Mode" />
      <div className="pill-row">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`pill${mode === m.key ? " pill-active" : ""}`}
            style={mode === m.key ? { background: m.color, color: "var(--c-void)" } : undefined}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {eng.error && (
        <Slab tint="var(--c-magenta)" cut={5} className="discovery-error-box">
          {eng.error}
        </Slab>
      )}

      {eng.collisions && (
        <Slab tint="var(--c-yellow)" cut={5} className="collision-box">
          <div className="label" style={{ color: "var(--c-yellow)" }}>
            ⚠ ALREADY ENGAGED DIFFERENTLY — TERMINALS USING THESE PROFILES WILL BE REPOINTED
          </div>
          {eng.collisions.map((c) => (
            <div key={c.alias} className="label collision-line">
              {c.alias} is currently {ENV_LABELS[c.current.env]}/{MODES.find((m) => m.key === c.current.mode)!.label}
              {c.current.project ? ` (via ${c.current.project})` : ""}
            </div>
          ))}
          <div className="collision-actions">
            <button className="label hover-glow" style={{ color: "var(--c-yellow)" }} onClick={eng.acknowledgeCollisions}>
              ENGAGE ANYWAY
            </button>
            <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={eng.dismissCollisions}>
              CANCEL
            </button>
          </div>
        </Slab>
      )}

      <SectionRule title="Members" />
      <div className="member-list">
        {members.map((a) => {
          const row = eng.rows[a.alias];
          const target = a.environments[env] ?? a.environments.global;
          const note = eng.outcome?.succeeded.find((s) => s.alias === a.alias)?.note;
          return (
            <Slab key={a.alias} cut={5} className="member-row">
              <span className="service-display-name member-alias">{a.displayName || a.alias}</span>
              <span className="label service-slug">{a.alias}</span>
              <span className="label" style={{ color: "var(--c-dim)" }}>
                {target ? target.accountId : `no ${ENV_LABELS[env]} account`}
              </span>
              <span className="label" style={{ color: statusColor(row), marginLeft: "auto" }}>
                {statusLabel(row)}
                {note ? ` · ${note}` : ""}
              </span>
            </Slab>
          );
        })}
      </div>

      {rowEntries.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <SegmentedMeter fraction={doneFraction} color={activeMode.color} />
        </div>
      )}

      <div className="engage-actions">
        <HoldButton
          label={eng.busy ? "ENGAGING…" : `ENGAGE ${ENV_LABELS[env]}/${activeMode.label}`}
          holdLabel={`HOLD — ADMIN → ${ENV_LABELS[env]}`}
          color={env === "prd" ? "var(--c-magenta)" : activeMode.color}
          requireHold={isPrdAdmin}
          disabled={eng.busy || members.length === 0}
          onConfirm={engage}
        />
        {!eng.busy && eng.outcome && eng.outcome.failed.length > 0 && (
          <button className="label hover-glow" style={{ color: "var(--c-yellow)" }} onClick={eng.retryFailed}>
            RETRY FAILED ({eng.outcome.failed.length})
          </button>
        )}
      </div>
    </div>
  );
}
