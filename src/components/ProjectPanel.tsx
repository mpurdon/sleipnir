import { useState } from "react";
import type { Account, AppState, Env, Project } from "../lib/types";
import { accountName, ENV_LABELS, MODES, sortEnvs } from "../lib/constants";
import { SectionRule, Slab } from "../theme";

/**
 * Project settings: membership, and deleting the project. Engaging lives on
 * the project card, not here.
 *
 * Membership changes persist as they are made. The panel used to hold them
 * as a draft behind SAVE/CANCEL, which meant a change could be lost by
 * leaving via the back link — and once deleting a project moved in here,
 * "settings you must remember to save" sat oddly beside an action that
 * takes effect at once. Local state still updates first so the list responds
 * instantly; the write follows.
 */
export function ProjectPanel({
  project,
  accounts,
  state,
  onUpdate,
  onDelete,
  onBack,
}: {
  project: Project;
  accounts: Account[];
  state: AppState;
  /** Persists the edited project (same upsert as creation). */
  onUpdate: (p: Project) => Promise<void> | void;
  /** Soft-delete — the project is archived and restorable, which is why this
   * confirms in place rather than with a dire modal. */
  onDelete: (name: string) => Promise<void> | void;
  onBack: () => void;
}) {
  const [members, setMembers] = useState<string[]>(project.members);
  const [adding, setAdding] = useState(false);
  const [addFilter, setAddFilter] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /** Optimistic locally, persisted immediately. A failed write surfaces as
   * an error banner from the config layer rather than silently diverging. */
  function setMembersAndSave(next: string[]) {
    setMembers(next);
    void onUpdate({ ...project, members: next });
  }

  const last = state.lastEngage[`project:${project.name}`];
  const lastLabel = last
    ? `LAST ENGAGED ${ENV_LABELS[last.env]}/${MODES.find((m) => m.key === last.mode)!.label} · ${new Date(last.atUnixMs).toLocaleString()}`
    : null;

  const memberAccounts = members
    .map((alias) => accounts.find((a) => a.alias === alias))
    .filter((a): a is Account => !!a);

  const q = addFilter.trim().toLowerCase();
  const candidates = accounts
    .filter(
      (a) =>
        a.org === project.org &&
        !members.includes(a.alias) &&
        (q === "" || a.alias.includes(q) || accountName(a).toLowerCase().includes(q)),
    )
    .sort((a, b) => accountName(a).localeCompare(accountName(b)));

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

      <SectionRule title={`Members (${members.length})`} />
      <div className="member-list">
        {memberAccounts.map((a) => (
          <Slab key={a.alias} cut={5} className="member-row">
            <span className="service-display-name member-alias">{accountName(a)}</span>
            <span className="label service-slug">{a.alias}</span>
            <div className="env-chips">
              {sortEnvs(Object.keys(a.environments) as Env[]).map((e) => (
                <span key={e} className="label env-chip">
                  {ENV_LABELS[e]}
                </span>
              ))}
            </div>
            <button
              className="member-remove hover-glow"
              title={`Remove ${a.alias} from ${project.name}`}
              onClick={() => setMembersAndSave(members.filter((m) => m !== a.alias))}
            >
              ✕
            </button>
          </Slab>
        ))}
        {members.length === 0 && (
          <div className="label" style={{ color: "var(--c-dim)" }}>
            NO MEMBERS — ADD SOME SERVICES BELOW
          </div>
        )}
      </div>

      {adding ? (
        <div className="add-member-box">
          <div className="catalog-toolbar">
            <input
              className="catalog-filter"
              placeholder="Type to find a service…"
              value={addFilter}
              onChange={(e) => setAddFilter(e.target.value)}
              autoFocus
            />
            <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={() => setAdding(false)}>
              DONE
            </button>
          </div>
          <div className="member-list add-member-list">
            {candidates.map((a) => (
              <button
                key={a.alias}
                className="checkbox-row hover-glow"
                title={`Add ${a.alias} to ${project.name}`}
                onClick={() => setMembersAndSave([...members, a.alias])}
              >
                <span className="label" style={{ color: "var(--c-cyan)" }}>
                  +
                </span>
                <span className="service-display-name">{accountName(a)}</span>
                <span className="label service-slug">{a.alias}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button className="label hover-glow" style={{ color: "var(--c-cyan)", alignSelf: "flex-start" }} onClick={() => setAdding(true)}>
          + ADD SERVICES
        </button>
      )}

      <SectionRule title="Danger" />
      {confirmingDelete ? (
        <div className="danger-confirm">
          <span className="label" style={{ color: "var(--c-dim)", textTransform: "none" }}>
            Delete <strong style={{ color: "var(--c-text)" }}>{project.name}</strong>? It moves to
            RECENTLY DELETED in the projects list and can be restored. Anything currently engaged
            through it stays engaged.
          </span>
          <div className="danger-actions">
            <button
              className="label hover-glow"
              style={{ color: "var(--c-magenta)" }}
              onClick={async () => {
                await onDelete(project.name);
                onBack();
              }}
            >
              DELETE PROJECT
            </button>
            <button
              className="label hover-glow"
              style={{ color: "var(--c-dim)" }}
              onClick={() => setConfirmingDelete(false)}
            >
              KEEP IT
            </button>
          </div>
        </div>
      ) : (
        <button
          className="label hover-glow"
          style={{ color: "var(--c-magenta)", alignSelf: "flex-start" }}
          onClick={() => setConfirmingDelete(true)}
        >
          DELETE PROJECT…
        </button>
      )}

      <button className="engage-btn hover-glow project-close" onClick={onBack}>
        CLOSE
      </button>
    </div>
  );
}
