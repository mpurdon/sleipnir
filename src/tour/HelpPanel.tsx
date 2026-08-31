import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SectionRule, Slab } from "../theme";
import { DOCS_URL, TOURS } from "./tours";

/**
 * The help tab in Settings: every guided tour, whether you have finished
 * it, and a way out to the written docs.
 *
 * Starting a tour closes Settings, because a tour that points at the rail
 * behind an open Settings drawer would be pointing at nothing.
 */
export function HelpPanel({
  isCompleted,
  onStartTour,
  onResetProgress,
}: {
  isCompleted: (id: string) => boolean;
  onStartTour: (id: string) => void;
  onResetProgress: () => void;
}) {
  const [docsError, setDocsError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  async function openDocs() {
    setDocsError(null);
    try {
      await openUrl(DOCS_URL);
    } catch {
      // Never leave the user stuck: if the shell refuses, show the URL so
      // it can be copied by hand.
      setDocsError(DOCS_URL);
    }
  }

  const doneCount = TOURS.filter((t) => isCompleted(t.id)).length;

  return (
    <div className="settings-section">
      <SectionRule title="Guided tours" />

      <div className="label" style={{ color: "var(--c-dim)" }}>
        {doneCount} OF {TOURS.length} COMPLETED · A TOUR POINTS AT THE REAL CONTROLS — NOTHING IS CHANGED FOR YOU
      </div>

      <div className="tour-list">
        {TOURS.map((t) => {
          const done = isCompleted(t.id);
          return (
            <Slab key={t.id} cut={5} tint={done ? "var(--c-lime)" : "var(--c-edge)"} className="tour-list-row">
              <div className="tour-list-head">
                <span className="tour-list-name">{t.title}</span>
                {done && (
                  <span className="label" style={{ color: "var(--c-lime)" }}>
                    ✓ DONE
                  </span>
                )}
                <span className="label" style={{ color: "var(--c-dim)" }}>
                  {t.length}
                </span>
              </div>
              <div className="tour-list-blurb">{t.blurb}</div>
              <button
                className="label hover-glow tour-list-start"
                style={{ color: "var(--c-cyan)" }}
                onClick={() => onStartTour(t.id)}
              >
                {done ? "↻ REPLAY" : "▸ START"}
              </button>
            </Slab>
          );
        })}
      </div>

      <SectionRule title="Written docs" />

      <div className="tour-list-blurb">
        The full handbook — discovery, projects, safety, the AWS files Sleipnir edits, and troubleshooting.
      </div>
      <button className="label hover-glow" style={{ color: "var(--c-cyan)", alignSelf: "flex-start" }} onClick={() => void openDocs()}>
        OPEN HELP DOCS ↗
      </button>
      {docsError && (
        <div className="label" style={{ color: "var(--c-dim)", textTransform: "none", userSelect: "text" }}>
          Could not open a browser. Visit: {docsError}
        </div>
      )}

      <SectionRule title="Reset" />

      {confirmReset ? (
        <div className="tour-reset-confirm">
          <span className="label" style={{ color: "var(--c-yellow)" }}>
            MARK ALL TOURS UNSEEN?
          </span>
          <button
            className="label hover-glow"
            style={{ color: "var(--c-magenta)" }}
            onClick={() => {
              onResetProgress();
              setConfirmReset(false);
            }}
          >
            YES, RESET
          </button>
          <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={() => setConfirmReset(false)}>
            CANCEL
          </button>
        </div>
      ) : (
        <button
          className="label hover-glow"
          style={{ color: "var(--c-dim)", alignSelf: "flex-start" }}
          onClick={() => setConfirmReset(true)}
        >
          RESET TOUR PROGRESS
        </button>
      )}
    </div>
  );
}
