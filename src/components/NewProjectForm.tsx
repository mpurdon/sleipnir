import { useState } from "react";
import type { Account, Env, Project } from "../lib/types";
import { accountName, sortEnvs } from "../lib/constants";
import { SectionRule } from "../theme";

export function NewProjectForm({
  orgName,
  accounts,
  onCreate,
  onCancel,
}: {
  orgName: string;
  accounts: Account[];
  onCreate: (p: Project) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const mine = accounts.filter((a) => a.org === orgName);
  const q = filter.trim().toLowerCase();
  const matches = (a: Account) => !q || a.alias.includes(q) || accountName(a).toLowerCase().includes(q);
  // Selected rows always stay visible above the filtered rest, so the
  // choices already made never vanish while narrowing.
  const shown = [
    ...mine.filter((a) => selected.has(a.alias)),
    ...mine.filter((a) => !selected.has(a.alias) && matches(a)),
  ];

  function toggle(alias: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  function submit() {
    if (!name.trim() || selected.size === 0) return;
    onCreate({ name: name.trim(), org: orgName, members: [...selected] });
  }

  return (
    <div className="project-panel">
      <button className="back-link label hover-glow" onClick={onCancel} style={{ color: "var(--c-dim)" }}>
        ‹ ALL PROJECTS
      </button>

      <h1 className="project-title">New Project</h1>

      <input
        className="project-name-input"
        placeholder="PROJECT NAME"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />

      <SectionRule title={`Services (${selected.size} selected)`} />

      {mine.length === 0 ? (
        <div className="label" style={{ color: "var(--c-dim)" }}>
          NO SERVICES YET — RUN THE ORG SCAN FIRST
        </div>
      ) : (
        <>
          <input
            className="catalog-filter"
            placeholder="Type to filter services…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="member-list new-project-list">
            {shown.map((a) => (
              <label key={a.alias} className="checkbox-row hover-glow">
                <input type="checkbox" checked={selected.has(a.alias)} onChange={() => toggle(a.alias)} />
                <span className="service-display-name">{accountName(a)}</span>
                <span className="label service-slug">{a.alias}</span>
                <div className="env-chips">
                  {sortEnvs(Object.keys(a.environments) as Env[]).map((e) => (
                    <span key={e} className="label env-chip">
                      {e.toUpperCase()}
                    </span>
                  ))}
                </div>
              </label>
            ))}
          </div>
        </>
      )}

      <button
        className="engage-btn hover-glow"
        style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
        disabled={!name.trim() || selected.size === 0}
        onClick={submit}
      >
        CREATE PROJECT{selected.size > 0 ? ` (${selected.size})` : ""}
      </button>
    </div>
  );
}
