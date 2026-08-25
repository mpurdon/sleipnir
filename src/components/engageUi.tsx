import type { AppState, Env, Mode } from "../lib/types";
import { ENVS, ENV_LABELS, MODES } from "../lib/constants";
import type { useEngage } from "../lib/useEngage";
import { Slab } from "../theme";

export type Sel = { env: Env; mode: Mode };

export function defaultSel(state: AppState, key: string): Sel {
  const last = state.lastEngage[key];
  return last ? { env: last.env, mode: last.mode } : { env: "dev", mode: "powerUser" };
}

export function modeMeta(mode: Mode) {
  return MODES.find((m) => m.key === mode)!;
}

/** Small env/mode selector pills shared by project cards and service rows. */
export function SelPills({
  envs,
  modes,
  sel,
  onChange,
}: {
  envs: Env[];
  modes: Mode[];
  sel: Sel;
  onChange: (s: Sel) => void;
}) {
  return (
    <div className="sel-pills">
      <div className="pill-row pill-row-mini">
        {ENVS.filter((e) => envs.includes(e)).map((e) => (
          <button
            key={e}
            className={`pill pill-mini${sel.env === e ? " pill-active" : ""}${e === "prd" && sel.env === e ? " pill-prd" : ""}`}
            onClick={() => onChange({ ...sel, env: e })}
          >
            {ENV_LABELS[e]}
          </button>
        ))}
      </div>
      <div className="pill-row pill-row-mini">
        {MODES.filter((m) => modes.includes(m.key)).map((m) => (
          <button
            key={m.key}
            className={`pill pill-mini${sel.mode === m.key ? " pill-active" : ""}`}
            style={sel.mode === m.key ? { background: m.color, color: "var(--c-void)" } : undefined}
            onClick={() => onChange({ ...sel, mode: m.key })}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Shared engage feedback: error box, collision-acknowledge gate, and the
 * live activity rows. Renders nothing after a clean engage — the rail's
 * ENGAGED groups already say it; the panel only persists when something
 * needs attention (failures to retry, fallback notes to read).
 */
export function EngageFeedback({ eng }: { eng: ReturnType<typeof useEngage> }) {
  const activityRows = Object.entries(eng.rows);
  const noteworthy =
    eng.outcome && (eng.outcome.failed.length > 0 || eng.outcome.succeeded.some((s) => s.note));

  return (
    <>
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
              {c.alias} is currently {ENV_LABELS[c.current.env]}/{modeMeta(c.current.mode).label}
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

      {(eng.busy || noteworthy) && activityRows.length > 0 && (
        <Slab cut={5} className="engage-activity">
          <div className="engaged-strip-head">
            <span className="label" style={{ color: "var(--c-cyan)" }}>
              {eng.busy ? "ENGAGING…" : "ENGAGE RESULT"}
            </span>
            {!eng.busy && eng.outcome && eng.outcome.failed.length > 0 && (
              <button className="label hover-glow" style={{ color: "var(--c-yellow)" }} onClick={eng.retryFailed}>
                RETRY FAILED ({eng.outcome.failed.length})
              </button>
            )}
            {!eng.busy && (
              <button className="label hover-glow engaged-strip-all" style={{ color: "var(--c-dim)" }} onClick={eng.reset}>
                DISMISS
              </button>
            )}
          </div>
          <div className="engage-activity-rows">
            {activityRows.map(([alias, r]) => {
              const note = eng.outcome?.succeeded.find((s) => s.alias === alias)?.note;
              return (
                <div key={alias} className="engage-activity-row">
                  <span className="member-alias">{alias}</span>
                  <span
                    className="label"
                    style={{
                      color:
                        r.status === "done" ? "var(--c-lime)" : r.status === "failed" ? "var(--c-magenta)" : "var(--c-cyan)",
                    }}
                  >
                    {r.status === "assuming" ? "ASSUMING ROLE" : r.status.toUpperCase()}
                  </span>
                  {(r.message || note) && (
                    <span className="label" style={{ color: r.message ? "var(--c-magenta)" : "var(--c-yellow)" }}>
                      {r.message ?? note}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Slab>
      )}
    </>
  );
}
