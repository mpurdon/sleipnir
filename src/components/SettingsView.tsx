import { useState } from "react";
import type { Account, Org } from "../lib/types";
import type { OrgConfig } from "../lib/tauri";
import { AccountsView } from "./AccountsView";
import { OrgsSettings } from "./OrgsSettings";
import { DeveloperTab } from "./DeveloperTab";

type SettingsTab = "orgs" | "accounts" | "developer";
const TABS: SettingsTab[] = ["orgs", "accounts", "developer"];

export function SettingsView({
  orgs,
  activeOrgName,
  accounts,
  onBack,
  onSaveOrg,
  onDeleteOrg,
  onSignOutOrg,
  onSaveAccount,
  onDeleteAccount,
}: {
  orgs: Org[];
  activeOrgName: string;
  accounts: Account[];
  onBack: () => void;
  onSaveOrg: (o: OrgConfig) => void;
  onDeleteOrg: (name: string) => void;
  onSignOutOrg: (name: string) => void;
  onSaveAccount: (a: Account) => void;
  onDeleteAccount: (alias: string) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("orgs");

  return (
    <div className="settings-view">
      <button className="back-link label hover-glow" onClick={onBack} style={{ color: "var(--c-dim)" }}>
        ‹ BACK
      </button>

      <h1 className="project-title">Settings</h1>

      <div className="pill-row view-tabs">
        {TABS.map((t) => (
          <button key={t} className={`pill${tab === t ? " pill-active" : ""}`} onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {tab === "orgs" && <OrgsSettings orgs={orgs} onSave={onSaveOrg} onDelete={onDeleteOrg} onSignOut={onSignOutOrg} />}
      {tab === "accounts" && (
        <AccountsView orgName={activeOrgName} accounts={accounts} onSave={onSaveAccount} onDelete={onDeleteAccount} />
      )}
      {tab === "developer" && <DeveloperTab />}
    </div>
  );
}
