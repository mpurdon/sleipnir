import { useState } from "react";
import type { Org } from "../lib/types";
import type { OrgConfig } from "../lib/tauri";
import { Slab } from "../theme";

/** Strips a trailing `#/` route fragment and trailing slashes — the AWS
 * SSO OIDC endpoint rejects both, and copy-pasting from the portal page
 * reliably produces them. */
function sanitizeStartUrl(raw: string): string {
  return raw.trim().split("#")[0]!.replace(/\/+$/, "");
}

function status(org: Org): { label: string; color: string } {
  if (!org.tokenExpiresAt) return { label: "NOT LOGGED IN", color: "var(--c-magenta)" };
  const msLeft = new Date(org.tokenExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return { label: "SESSION EXPIRED", color: "var(--c-magenta)" };
  const mins = Math.floor(msLeft / 60_000);
  return { label: `LOGGED IN · ${mins >= 60 ? `${Math.floor(mins / 60)}H ${mins % 60}M` : `${mins}M`} LEFT`, color: "var(--c-lime)" };
}

/** Config + session control for one org (or a blank form when adding). */
export function OrgDrawer({
  org,
  loggingIn,
  onSave,
  onDelete,
  onSignOut,
  onLogin,
  onClose,
}: {
  org: Org | null;
  loggingIn: boolean;
  onSave: (o: OrgConfig) => void;
  onDelete: (name: string) => void;
  onSignOut: (name: string) => void;
  onLogin: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(org?.name ?? "");
  const [startUrl, setStartUrl] = useState(org?.startUrl ?? "");
  const [region, setRegion] = useState(org?.region ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const dirty =
    !org || name.trim() !== org.name || sanitizeStartUrl(startUrl) !== org.startUrl || region.trim() !== org.region;

  function submit() {
    if (!name.trim() || !startUrl.trim() || !region.trim()) return;
    onSave({ name: name.trim(), startUrl: sanitizeStartUrl(startUrl), region: region.trim() });
    if (!org) onClose();
  }

  return (
    <div className="drawer-stack">
      {org && (
        <div className="org-drawer-status">
          <span className="label" style={{ color: status(org).color }}>
            {status(org).label}
          </span>
          <button
            className="label hover-glow"
            style={{ color: "var(--c-cyan)" }}
            disabled={loggingIn}
            onClick={() => onLogin(org.name)}
          >
            {loggingIn ? "LOGGING IN…" : "LOG IN"}
          </button>
          <button className="label hover-glow" style={{ color: "var(--c-yellow)" }} onClick={() => onSignOut(org.name)}>
            SIGN OUT
          </button>
        </div>
      )}

      <Slab cut={5} className="add-org-form">
        <input placeholder="ORG NAME (e.g. personal)" value={name} onChange={(e) => setName(e.target.value)} disabled={!!org} autoFocus={!org} />
        <input placeholder="SSO START URL" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} />
        <span className="label" style={{ color: "var(--c-dim)", textTransform: "none", letterSpacing: 0 }}>
          e.g. https://your-org.awsapps.com/start — the bare start URL, not one copied while browsing the portal
        </span>
        <input placeholder="REGION (e.g. us-east-2)" value={region} onChange={(e) => setRegion(e.target.value)} />
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
