import { useMemo, useState } from "react";
import type { Account, AppState, DeletedProject, Env, Mode, Org, Project } from "../lib/types";
import { ENV_LABELS } from "../lib/constants";
import { useEngage } from "../lib/useEngage";
import { clampSel, defaultSel, EngageFeedback, modeMeta, SelPills, type Sel } from "./engageUi";
import { HoldButton } from "./HoldButton";
import { NewProjectForm } from "./NewProjectForm";
import { ProjectPanel } from "./ProjectPanel";
import { Slab } from "../theme";

type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; name: string };

function sinceLabel(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "JUST NOW";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}M AGO`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}H AGO`;
  return `${Math.round(hrs / 24)}D AGO`;
}


/**
 * The archive. Deleting a project is reversible, and this is where the undo
 * lives — separate from the drawer so it can be rendered and checked on its
 * own, and because the drawer was already long enough.
 */
export function DeletedProjects({
  deleted,
  onRestore,
  onPurge,
}: {
  deleted: DeletedProject[];
  onRestore: (name: string) => Promise<void> | void;
  onPurge: (name: string) => Promise<void> | void;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState<string | null>(null);

  if (deleted.length === 0) return null;

  return (
    <div className="deleted-projects" data-tour="projects-deleted">
      <button
        className="label hover-glow"
        style={{ color: "var(--c-dim)", alignSelf: "flex-start" }}
        onClick={() => setShowDeleted((v) => !v)}
      >
        <span className="chev">{showDeleted ? "▾" : "▸"}</span> RECENTLY DELETED ({deleted.length})
      </button>

      {showDeleted &&
        deleted.map((d) => (
          <Slab key={d.name} cut={5} tint="var(--c-edge)" className="deleted-row">
            <div className="deleted-row-head">
              <span className="deleted-name">{d.name}</span>
              <span className="label" style={{ color: "var(--c-dim)" }}>
                {sinceLabel(d.deletedAtUnixMs)}
              </span>
            </div>
            <div className="label" style={{ color: "var(--c-dim)" }}>
              {d.members.length} SERVICE{d.members.length === 1 ? "" : "S"}
            </div>
            {confirmingPurge === d.name ? (
              <div className="danger-actions">
                <span className="label" style={{ color: "var(--c-magenta)" }}>
                  PERMANENT — NO UNDO
                </span>
                <button
                  className="label hover-glow"
                  style={{ color: "var(--c-magenta)" }}
                  onClick={() => {
                    void onPurge(d.name);
                    setConfirmingPurge(null);
                  }}
                >
                  DELETE FOREVER
                </button>
                <button
                  className="label hover-glow"
                  style={{ color: "var(--c-dim)" }}
                  onClick={() => setConfirmingPurge(null)}
                >
                  CANCEL
                </button>
              </div>
            ) : (
              <div className="danger-actions">
                <button
                  className="label hover-glow"
                  style={{ color: "var(--c-cyan)" }}
                  onClick={() => void onRestore(d.name)}
                >
                  ↩ RESTORE
                </button>
                <button
                  className="label hover-glow"
                  style={{ color: "var(--c-dim)" }}
                  onClick={() => setConfirmingPurge(d.name)}
                >
                  DELETE FOREVER…
                </button>
              </div>
            )}
          </Slab>
        ))}
    </div>
  );
}

export function ProjectsDrawer({
  org,
  accounts,
  projects,
  state,
  onStateChange,
  onTogglePin,
  onCreateProject,
  deletedProjects,
  onDeleteProject,
  onRestoreProject,
  onPurgeProject,
}: {
  org: Org;
  accounts: Account[];
  projects: Project[];
  state: AppState;
  onStateChange: (s: AppState) => void;
  onTogglePin: (project: string, pinned: boolean) => void;
  onCreateProject: (p: Project) => Promise<void>;
  /** The archive — deleting a project is reversible. */
  deletedProjects: DeletedProject[];
  onDeleteProject: (name: string) => Promise<void> | void;
  onRestoreProject: (name: string) => Promise<void> | void;
  onPurgeProject: (name: string) => Promise<void> | void;
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
          onDelete={onDeleteProject}
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
                title="Members, and deleting this project"
                onClick={() => setView({ kind: "detail", name: p.name })}
              >
                ⚙ SETTINGS
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

      <DeletedProjects
        deleted={deletedProjects}
        onRestore={onRestoreProject}
        onPurge={onPurgeProject}
      />
    </div>
  );
}
