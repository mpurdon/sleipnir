import { useEffect, useState } from "react";
import type { Account, AppState, EngagedProfile, Env, Mode, Project } from "../lib/types";
import { ENV_LABELS } from "../lib/constants";
import { useEngage } from "../lib/useEngage";
import { clampSel, defaultSel, EngageFeedback, modeMeta, SelPills, type Sel } from "./engageUi";
import { HoldButton } from "./HoldButton";

/**
 * Repoints an engaged project group from the rail: pick a new env/mode and
 * re-engage the project without opening the PROJECTS drawer. The group in
 * the rail *is* the project's live engagement, so this is where the user
 * is looking when they decide it should be somewhere else.
 *
 * Members come from the project's current membership, exactly as the card
 * does — a project whose config entry is gone (deleted while engaged)
 * falls back to the aliases actually in the group.
 */
export function RailRepoint({
  group,
  entries,
  projects,
  accounts,
  state,
  onStateChange,
}: {
  group: string;
  entries: [string, EngagedProfile][];
  projects: Project[];
  accounts: Account[];
  state: AppState;
  onStateChange: (s: AppState) => void;
}) {
  const eng = useEngage(onStateChange);
  const [editing, setEditing] = useState(false);
  const key = `project:${group}`;
  const project = projects.find((p) => p.name === group);
  const aliases = project?.members ?? entries.map(([alias]) => alias);
  const org = entries[0]?.[1].org ?? "";
  const members = aliases.map((a) => accounts.find((x) => x.alias === a)).filter((a): a is Account => !!a);
  const envs = [...new Set(members.flatMap((a) => Object.keys(a.environments) as Env[]))];
  const modes = [...new Set(members.flatMap((a) => Object.keys(a.roles) as Mode[]))];
  // Start from what the group is engaged at now — that is what "change"
  // means here — rather than the dev/powerUser default a fresh card gets.
  const current = entries[0]?.[1];
  const [sel, setSel] = useState<Sel>(() => (current ? { env: current.env, mode: current.mode } : defaultSel(state, key)));
  const s = clampSel(sel, envs, modes);
  const isPrdAdmin = s.env === "prd" && s.mode === "admin";
  const unchanged = entries.every(([, e]) => e.env === s.env && e.mode === s.mode);
  // Repointing this group only collides with itself — unless a member is
  // also held by another project or a direct engage, whose terminals would
  // be moved without that holder asking. Keep the gate for those.
  const sharedElsewhere = entries.some(([, e]) => (e.heldByProjects?.length ?? 0) + (e.heldAdhoc ? 1 : 0) > 1);

  // A clean repoint needs no further reading: fold the controls away. A
  // failure or a fallback note stays visible until dismissed.
  useEffect(() => {
    if (eng.outcome && eng.outcome.failed.length === 0 && !eng.outcome.succeeded.some((r) => r.note)) {
      setEditing(false);
      eng.reset();
    }
  }, [eng.outcome, eng.reset]);

  if (!editing) {
    return (
      <>
        <EngageFeedback eng={eng} />
        <button
          className="label hover-glow rail-repoint-link"
          title="Re-engage this project at a different environment or mode"
          onClick={() => setEditing(true)}
        >
          ⇄ CHANGE ENV/MODE
        </button>
      </>
    );
  }

  return (
    <div className="rail-repoint">
      <SelPills envs={envs} modes={modes} sel={s} onChange={setSel} />
      <HoldButton
        label={`ENGAGE ${ENV_LABELS[s.env]}/${modeMeta(s.mode).label}`}
        holdLabel={`HOLD — ADMIN → ${ENV_LABELS[s.env]}`}
        color={s.env === "prd" ? "var(--c-magenta)" : modeMeta(s.mode).color}
        requireHold={isPrdAdmin}
        disabled={eng.busy || unchanged || aliases.length === 0}
        onConfirm={() =>
          void eng.run({
            orgName: org,
            project: group,
            aliases,
            env: s.env,
            mode: s.mode,
            acknowledgeCollisions: !sharedElsewhere,
          })
        }
        className="home-card-engage"
      />
      <button
        className="label hover-glow rail-repoint-link"
        onClick={() => {
          setEditing(false);
          eng.reset();
        }}
      >
        CANCEL
      </button>
      <EngageFeedback eng={eng} />
    </div>
  );
}
