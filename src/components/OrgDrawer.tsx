import { useState } from "react";
import type { Org } from "../lib/types";
import type { OrgConfig } from "../lib/tauri";
import { sessionMsLeft, SSO_REGIONS } from "../lib/constants";
import { Slab } from "../theme";

/** Strips a trailing `#/` route fragment and trailing slashes — the AWS
 * SSO OIDC endpoint rejects both, and copy-pasting from the portal page
 * reliably produces them. */
function sanitizeStartUrl(raw: string): string {
  return raw.trim().split("#")[0]!.replace(/\/+$/, "");
}

function status(org: Org): { label: string; color: string; alive: boolean } {
  const msLeft = sessionMsLeft(org);
  if (msLeft <= 0) {
    const label = org.tokenExpiresAt ? "SESSION EXPIRED" : "NOT LOGGED IN";
    return { label, color: "var(--c-magenta)", alive: false };
  }
  const mins = Math.floor(msLeft / 60_000);
  return {
    label: `LOGGED IN · ${mins >= 60 ? `${Math.floor(mins / 60)}H ${mins % 60}M` : `${mins}M`} LEFT`,
    color: "var(--c-lime)",
    alive: true,
  };
}

/** Config + session control for one org (or a blank form when adding). */
export function OrgDrawer({
  org,
  loggingIn,
  onSave,
  onDelete,
  onSignOut,
  onLogin,
  onRefresh,
  onClose,
  onAdded,
}: {
  org: Org | null;
  loggingIn: boolean;
  onSave: (o: OrgConfig) => void;
  onDelete: (name: string) => void;
  onSignOut: (name: string) => void;
  onLogin: (name: string) => void;
  /** Silent token refresh — the button shown while the session is alive. */
  onRefresh: (name: string) => void;
  onClose: () => void;
  /** Called after a NEW org is saved and the user answered the
   * log-in-now prompt — the app closes the drawer, selects the org, and
   * starts the login when `loginNow`. */
  onAdded: (name: string, loginNow: boolean) => void;
}) {
  const [name, setName] = useState(org?.name ?? "");
  const [startUrl, setStartUrl] = useState(org?.startUrl ?? "");
  const [region, setRegion] = useState(org?.region ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [askLogin, setAskLogin] = useState(false);

  const dirty =
    !org || name.trim() !== org.name || sanitizeStartUrl(startUrl) !== org.startUrl || region.trim() !== org.region;

  function submit() {
    if (!name.trim() || !startUrl.trim() || !region.trim()) return;
    onSave({ name: name.trim(), startUrl: sanitizeStartUrl(startUrl), region: region.trim() });
    if (!org) setAskLogin(true);
  }

  if (askLogin) {
    return (
      <div className="drawer-stack">
        <Slab tint="var(--c-cyan)" cut={5} className="org-drawer-status">
          <span className="label" style={{ color: "var(--c-text)", flex: 1 }}>
            {name.trim().toUpperCase()} ADDED — LOG IN NOW?
          </span>
          <button
            className="engage-btn hover-glow"
            style={{ background: "var(--c-cyan)", color: "var(--c-void)", padding: "8px 18px" }}
            onClick={() => onAdded(name.trim(), true)}
          >
            LOG IN
          </button>
          <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={() => onAdded(name.trim(), false)}>
            LATER
          </button>
        </Slab>
      </div>
    );
  }

  return (
    <div className="drawer-stack">
      {org &&
        (() => {
          const st = status(org);
          return (
            <div className="org-drawer-status">
              <span className="label" style={{ color: st.color }}>
                {st.label}
              </span>
              {st.alive ? (
                <>
                  <button className="label hover-glow" style={{ color: "var(--c-cyan)" }} onClick={() => onRefresh(org.name)}>
                    ↻ REFRESH
                  </button>
                  <button className="label hover-glow" style={{ color: "var(--c-yellow)" }} onClick={() => onSignOut(org.name)}>
                    SIGN OUT
                  </button>
                </>
              ) : (
                <button
                  className="label hover-glow"
                  style={{ color: "var(--c-cyan)" }}
                  disabled={loggingIn}
                  onClick={() => onLogin(org.name)}
                >
                  {loggingIn ? "LOGGING IN…" : "LOG IN"}
                </button>
              )}
            </div>
          );
        })()}

      <Slab cut={5} className="add-org-form">
        <input placeholder="ORG NAME (e.g. personal)" value={name} onChange={(e) => setName(e.target.value)} disabled={!!org} autoFocus={!org} />
        <input placeholder="SSO START URL" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} />
        <span className="label" style={{ color: "var(--c-dim)", textTransform: "none", letterSpacing: 0 }}>
          e.g. https://your-org.awsapps.com/start — the bare start URL, not one copied while browsing the portal
        </span>
        <select value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="" disabled>
            SSO REGION…
          </option>
          {SSO_REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <span className="label" style={{ color: "var(--c-dim)", textTransform: "none", letterSpacing: 0 }}>
          the SSO region — check Identity Center → Settings in the AWS console if unsure
        </span>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button
            className="engage-btn hover-glow"
            style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
            disabled={!dirty || !name.trim() || !startUrl.trim() || !region.trim()}
            onClick={submit}
          >
            {org ? "SAVE" : "ADD ORG"}
          </button>
        </div>
      </Slab>

      {org &&
        (confirmingDelete ? (
          <Slab tint="var(--c-magenta)" cut={5} className="org-drawer-status">
            <span className="label" style={{ color: "var(--c-magenta)", flex: 1 }}>
              DELETE "{org.name}" — ALSO REMOVES ITS SERVICES &amp; PROJECTS. SURE?
            </span>
            <button
              className="label hover-glow"
              style={{ color: "var(--c-magenta)" }}
              onClick={() => {
                onDelete(org.name);
                onClose();
              }}
            >
              CONFIRM
            </button>
            <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={() => setConfirmingDelete(false)}>
              CANCEL
            </button>
          </Slab>
        ) : (
          <button
            className="label hover-glow"
            style={{ color: "var(--c-magenta)", alignSelf: "flex-start" }}
            onClick={() => setConfirmingDelete(true)}
          >
            DELETE ORG
          </button>
        ))}
    </div>
  );
}
