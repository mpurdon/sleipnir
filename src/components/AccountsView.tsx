import { useState } from "react";
import type { Account, Env } from "../lib/types";
import { MODES } from "../lib/constants";
import { SectionRule, Slab } from "../theme";
import { DiscoverPanel } from "./DiscoverPanel";

export function AccountsView({
  orgName,
  accounts,
  onSave,
  onDelete,
}: {
  orgName: string;
  accounts: Account[];
  onSave: (a: Account) => void;
  onDelete: (alias: string) => void;
}) {
  const [discovering, setDiscovering] = useState(false);
  const mine = accounts.filter((a) => a.org === orgName);

  function handleAdd(newOnes: Account[]) {
    newOnes.forEach(onSave);
    setDiscovering(false);
  }

  return (
    <div className="accounts-view">
      <div className="accounts-header">
        <SectionRule title="Accounts" />
        {!discovering && (
          <button
            className="engage-btn hover-glow accounts-discover-btn"
            style={{ background: "var(--c-cyan)", color: "var(--c-void)" }}
            onClick={() => setDiscovering(true)}
          >
            DISCOVER
          </button>
        )}
      </div>

      {discovering && (
        <DiscoverPanel
          orgName={orgName}
          existingAccounts={mine}
          onAdd={handleAdd}
          onClose={() => setDiscovering(false)}
        />
      )}

      {!discovering && (
        <div className="member-list">
          {mine.length === 0 && (
            <div className="label" style={{ color: "var(--c-dim)" }}>
              NO ACCOUNTS YET — CLICK DISCOVER
            </div>
          )}
          {mine.map((a) => (
            <Slab key={a.alias} cut={5} className="account-row">
              <div className="account-row-head">
                <span className="member-alias">{a.alias}</span>
                <div className="env-chips">
                  {(Object.keys(a.environments) as Env[]).map((e) => (
                    <span key={e} className="label env-chip">
                      {e.toUpperCase()}
                    </span>
                  ))}
                </div>
                <button className="label hover-glow" style={{ color: "var(--c-magenta)" }} onClick={() => onDelete(a.alias)}>
                  DELETE
                </button>
              </div>
              <div className="role-inputs">
                {MODES.map((m) => (
                  <label key={m.key} className="role-input-label">
                    <span className="label" style={{ color: m.color }}>
                      {m.label}
                    </span>
                    <input
                      value={a.roles[m.key] ?? ""}
                      placeholder="role name"
                      onChange={(e) => onSave({ ...a, roles: { ...a.roles, [m.key]: e.target.value } })}
                    />
                  </label>
                ))}
              </div>
            </Slab>
          ))}
        </div>
      )}
    </div>
  );
}
