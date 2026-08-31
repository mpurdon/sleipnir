import { useMemo, useState } from "react";
import type { Account, AppState, Env, Mode, Org, Project } from "../lib/types";
import { ENV_LABELS } from "../lib/constants";
import { useEngage } from "../lib/useEngage";
import { clampSel, defaultSel, EngageFeedback, modeMeta, SelPills, type Sel } from "./engageUi";
import { HoldButton } from "./HoldButton";
import { NewProjectForm } from "./NewProjectForm";
import { ProjectPanel } from "./ProjectPanel";
import { Slab } from "../theme";

type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; name: string };

export function ProjectsDrawer({
  org,
  accounts,
  projects,
  state,
  onStateChange,
  onTogglePin,
  onCreateProject,
}: {
  org: Org;
  accounts: Account[];
  projects: Project[];
  state: AppState;
  onStateChange: (s: AppState) => void;
  onTogglePin: (project: string, pinned: boolean) => void;
  onCreateProject: (p: Project) => Promise<void>;
}) {
  const eng = useEngage(onStateChange);
  const [view, setView] = useState<View>({ kind: "list" });
  const [sels, setSels] = useState<Record<string, Sel>>({});
  const [editingCard, setEditingCard] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const recency = (p: Project) => state.lastEngage[`project:${p.name}`]?.atUnixMs ?? 0;
    return [...projects].sort((a, b) => {
      const pinA = state.pins.includes(a.name) ? 0 : 1;
      const pinB = state.pins.includes(b.name) ? 0 : 1;
      if (pinA !== pinB) return pinA - pinB;
      const rec = recency(b) - recency(a);
      return rec !== 0 ? rec : a.name.localeCompare(b.name);
    });
  }, [projects, state.pins, state.lastEngage]);

  function sel(key: string): Sel {
    return sels[key] ?? defaultSel(state, key);
  }

  function projectEnvs(p: Project): Env[] {
    const set = new Set<Env>();
    for (const alias of p.members) {
      const a = accounts.find((x) => x.alias === alias);
      if (a) (Object.keys(a.environments) as Env[]).forEach((e) => set.add(e));
    }
    return [...set];
  }
  function projectModes(p: Project): Mode[] {
    const set = new Set<Mode>();
    for (const alias of p.members) {
      const a = accounts.find((x) => x.alias === alias);
      if (a) (Object.keys(a.roles) as Mode[]).forEach((m) => set.add(m));
    }
    return [...set];
  }

  if (view.kind === "new") {
    return (
      <NewProjectForm
        orgName={org.name}
        accounts={accounts}
        onCreate={async (p) => {
          await onCreateProject(p);
          setView({ kind: "detail", name: p.name });
        }}
        onCancel={() => setView({ kind: "list" })}
      />
    );
  }

  if (view.kind === "detail") {
    const project = projects.find((p) => p.name === view.name);
    if (project) {
      return (
        <ProjectPanel
          project={project}
          accounts={accounts}
          state={state}
          onUpdate={onCreateProject}
          onBack={() => setView({ kind: "list" })}
        />
      );
    }
  }

  return (
    <div className="drawer-stack">
      <EngageFeedback eng={eng} />

      {projects.length === 0 && (
        <div className="label" style={{ color: "var(--c-dim)" }}>
          NO PROJECTS YET — BUNDLE THE SERVICES YOU WORK ON INTO ONE
        </div>
      )}

      {sorted.map((p) => {
        const key = `project:${p.name}`;
        const s = clampSel(sel(key), projectEnvs(p), projectModes(p));
        const pinned = state.pins.includes(p.name);
        const isPrdAdmin = s.env === "prd" && s.mode === "admin";
        const last = state.lastEngage[key];
        return (
          <Slab key={p.name} tint={pinned ? "var(--c-cyan)" : "var(--c-edge)"} className="project-card home-card">
            <div className="home-card-head">
              <span className="home-card-name">{p.name}</span>
              <button
                className={`pin-btn hover-glow${pinned ? " pin-btn-on" : ""}`}
                title={pinned ? "Unpin" : "Pin to front"}
                onClick={() => onTogglePin(p.name, !pinned)}
                data-tour="project-pin"
              >
                {pinned ? "★" : "☆"}
              </button>
            </div>
            <div className="label" style={{ color: "var(--c-dim)" }}>
              {p.members.length} SERVICE{p.members.length === 1 ? "" : "S"}
              {last ? ` · LAST ${ENV_LABELS[last.env]}/${modeMeta(last.mode).label}` : ""}
            </div>
            {editingCard === key && (
              <SelPills envs={projectEnvs(p)} modes={projectModes(p)} sel={s} onChange={(v) => setSels((prev) => ({ ...prev, [key]: v }))} />
            )}
            <HoldButton
              label={`ENGAGE ${ENV_LABELS[s.env]}/${modeMeta(s.mode).label}`}
              holdLabel={`HOLD — ADMIN → ${ENV_LABELS[s.env]}`}
              color={s.env === "prd" ? "var(--c-magenta)" : modeMeta(s.mode).color}
              requireHold={isPrdAdmin}
              disabled={eng.busy || p.members.length === 0}
              onConfirm={() =>
                void eng.run({ orgName: org.name, project: p.name, aliases: p.members, env: s.env, mode: s.mode })
              }
              className="home-card-engage"
              tourAnchor="project-engage"
            />
            <div className="card-links">
              <button className="label hover-glow card-change-link" onClick={() => setEditingCard(editingCard === key ? null : key)}>
                {editingCard === key ? "DONE" : "CHANGE ENV/MODE"}
              </button>
              <button
                className="label hover-glow card-change-link"
                style={{ color: "var(--c-cyan)" }}
                title="Add or remove this project's services"
                onClick={() => setView({ kind: "detail", name: p.name })}
              >
                ✎ EDIT SERVICES
              </button>
            </div>
          </Slab>
        );
      })}

      <button
        className="label hover-glow"
        style={{ color: "var(--c-cyan)", alignSelf: "flex-start" }}
        onClick={() => setView({ kind: "new" })}
        data-tour="projects-new"
      >
        + NEW PROJECT
      </button>
    </div>
  );
}
