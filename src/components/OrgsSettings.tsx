import { useState } from "react";
import type { Org } from "../lib/types";
import type { OrgConfig } from "../lib/tauri";
import { SectionRule, Slab } from "../theme";

/**
 * Strips a trailing `#/`-style route fragment and any trailing slash —
 * the AWS SSO OIDC device-authorization endpoint rejects a `start_url`
 * carrying either, and copy-pasting the URL from the browser while sitting
 * on the SSO portal page (rather than typing the bare start URL) reliably
 * produces exactly that (e.g. `https://foo.awsapps.com/start#/`).
 */
function sanitizeStartUrl(raw: string): string {
  return raw.trim().split("#")[0]!.replace(/\/+$/, "");
}

function status(org: Org): { label: string; color: string } {
  if (!org.tokenExpiresAt) return { label: "NOT LOGGED IN", color: "var(--c-magenta)" };
  const msLeft = new Date(org.tokenExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return { label: "EXPIRED", color: "var(--c-magenta)" };
  return { label: "LOGGED IN", color: "var(--c-lime)" };
}

export function OrgsSettings({
  orgs,
  onSave,
  onDelete,
  onSignOut,
}: {
  orgs: Org[];
  onSave: (o: OrgConfig) => void;
  onDelete: (name: string) => void;
  onSignOut: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [region, setRegion] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  function submit() {
    if (!name.trim() || !startUrl.trim() || !region.trim()) return;
    onSave({ name: name.trim(), startUrl: sanitizeStartUrl(startUrl), region: region.trim() });
    setName("");
    setStartUrl("");
    setRegion("us-east-1");
    setAdding(false);
  }

  return (
    <div className="settings-section">
      <SectionRule title="Orgs" />

      <div className="member-list">
        {orgs.map((org) => {
          const s = status(org);
          const confirming = confirmingDelete === org.name;
          return (
            <Slab key={org.name} cut={5} tint={confirming ? "var(--c-magenta)" : undefined} className="org-settings-row">
              {confirming ? (
                <>
                  <span className="label" style={{ color: "var(--c-magenta)", flex: 1 }}>
                    DELETE "{org.name}" — ALSO REMOVES ITS ACCOUNTS &amp; PROJECTS. SURE?
                  </span>
                  <button
                    className="label hover-glow"
                    style={{ color: "var(--c-magenta)" }}
                    onClick={() => {
                      onDelete(org.name);
                      setConfirmingDelete(null);
                    }}
                  >
                    CONFIRM DELETE
                  </button>
                  <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={() => setConfirmingDelete(null)}>
                    CANCEL
                  </button>
                </>
              ) : (
                <>
                  <span className="member-alias">{org.name}</span>
                  <span className="label org-settings-url">{org.startUrl}</span>
                  <span className="label" style={{ color: s.color }}>
                    {s.label}
                  </span>
                  <button className="label hover-glow" style={{ color: "var(--c-yellow)" }} onClick={() => onSignOut(org.name)}>
                    SIGN OUT
                  </button>
                  <button
                    className="label hover-glow"
                    style={{ color: "var(--c-magenta)" }}
                    onClick={() => setConfirmingDelete(org.name)}
                  >
                    DELETE
                  </button>
                </>
              )}
            </Slab>
          );
        })}
        {orgs.length === 0 && (
          <div className="label" style={{ color: "var(--c-dim)" }}>
            NO ORGS CONFIGURED
          </div>
        )}
      </div>

      {adding ? (
        <Slab cut={5} className="add-org-form">
          <input placeholder="ORG NAME (e.g. personal)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input placeholder="SSO START URL" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} />
          <span className="label" style={{ color: "var(--c-dim)", textTransform: "none", letterSpacing: 0 }}>
            e.g. https://your-org.awsapps.com/start — not a URL copied while browsing the portal itself, that
            carries a #/ route fragment sleipnir strips automatically but which usually means you copied the
            wrong page
          </span>
          <input placeholder="REGION (e.g. us-east-2)" value={region} onChange={(e) => setRegion(e.target.value)} />
          <span className="label" style={{ color: "var(--c-dim)", textTransform: "none", letterSpacing: 0 }}>
            the SSO region, not necessarily where your workloads run — check Identity Center → Settings in the AWS
            console if unsure
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="engage-btn hover-glow"
              style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
              onClick={submit}
            >
              ADD ORG
            </button>
            <button className="label hover-glow" style={{ color: "var(--c-dim)" }} onClick={() => setAdding(false)}>
              CANCEL
            </button>
          </div>
        </Slab>
      ) : (
        <button className="label hover-glow" style={{ color: "var(--c-cyan)" }} onClick={() => setAdding(true)}>
          + ADD ORG
        </button>
      )}
    </div>
  );
}
