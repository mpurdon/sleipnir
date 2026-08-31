import { useEffect, useState } from "react";
import { Rail } from "./components/Rail";
import { Drawer } from "./components/Drawer";
import { ProjectsDrawer } from "./components/ProjectsDrawer";
import { ServicesDrawer } from "./components/ServicesDrawer";
import { OrgDrawer } from "./components/OrgDrawer";
import { SettingsView } from "./components/SettingsView";
import { isSessionAlive } from "./lib/constants";
import { useOrgs } from "./lib/useOrgs";
import { useConfig } from "./lib/useConfig";
import { useAppState } from "./lib/useAppState";
import { chooseSide, DRAWER_ANIM_MS, expandFrame, prepareCollapse, type DrawerSide } from "./lib/drawerWindow";
import { isDevBuild } from "./lib/tauri";
import { useTour } from "./tour/useTour";
import { TourOverlay } from "./tour/TourOverlay";
import "./tour/tour.css";
import "./App.css";

type DrawerKind =
  | { kind: "projects" }
  | { kind: "services" }
  | { kind: "settings" }
  | { kind: "org"; name: string | null };

function drawerTitle(d: DrawerKind): string {
  switch (d.kind) {
    case "projects":
      return "PROJECTS";
    case "services":
      return "SERVICES";
    case "settings":
      return "SETTINGS";
    case "org":
      return d.name ? `ORG · ${d.name.toUpperCase()}` : "NEW ORG";
  }
}

export function App() {
  const {
    orgs,
    loaded: orgsLoaded,
    login,
    refresh: refreshOrgs,
    refreshOne,
    activeLoginName,
    activeLoginProgress,
    addOrg,
    removeOrg,
    signOut,
    error: orgsError,
    clearError: clearOrgsError,
  } = useOrgs();
  const {
    accounts,
    projects,
    upsertAccount,
    removeAccount,
    upsertProject,
    replaceAccounts,
    error: configError,
    clearError: clearConfigError,
  } = useConfig();
  const {
    state: appState,
    replaceState,
    togglePin,
    disengageProfiles,
    disengageEverything,
    error: stateError,
    clearError: clearStateError,
  } = useAppState();
  const [activeOrg, setActiveOrg] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  const [side, setSide] = useState<DrawerSide>("right");
  /** Rail width frozen at drawer-open time so the rail doesn't reflow
   * while the drawer slides. */
  const [railPx, setRailPx] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  /** Pulses the SERVICES menu item after adding an org — scan is the
   * natural next step; cleared once the drawer is opened. */
  const [highlightServices, setHighlightServices] = useState(false);
  /** Drives the drawer's CSS slide: "in" on mount, "out" before unmount. */
  const [drawerAnim, setDrawerAnim] = useState<"in" | "out">("in");
  /** Which tab Settings opens on — the rail's ? button routes to help. */
  const [settingsTab, setSettingsTab] = useState<"help" | "orgs">("orgs");
  /** Marks the rail when this is a `tauri dev` build, which runs against
   * ~/.sleipnir-dev rather than your real config. */
  const [devBuild, setDevBuild] = useState(false);
  const tour = useTour();

  useEffect(() => {
    // A failure here means no Tauri IPC at all, which is not a dev build in
    // any sense worth badging — leave it off.
    isDevBuild()
      .then(setDevBuild)
      .catch(() => setDevBuild(false));
  }, []);

  // Default to the first Org once the real list loads.
  useEffect(() => {
    if (!activeOrg && orgs.length > 0) setActiveOrg(orgs[0]!.name);
  }, [orgs, activeOrg]);

  async function closeDrawer() {
    if (closing) return;
    setClosing(true);
    // Pre-arm the frame shrink (all IPC reads done now) so it can fire
    // with zero latency right as the slide lands.
    let shrink: (() => Promise<void>) | null = null;
    try {
      shrink = await prepareCollapse(side);
    } catch {
      /* window API unavailable */
    }
    setDrawerAnim("out");
    // Fire one frame early — the shrink lands as the slide finishes, so
    // there's never a beat of empty space where the drawer was.
    await new Promise((r) => setTimeout(r, DRAWER_ANIM_MS - 16));
    try {
      await shrink?.();
    } catch {
      /* nothing to restore */
    }
    setDrawer(null);
    setRailPx(null);
    setClosing(false);
  }

  async function openDrawer(d: DrawerKind) {
    if (closing) return;
    if (drawer) {
      // Switching tabs: let the current drawer glide shut before the next
      // one slides out — never a hard content swap mid-flight.
      await closeDrawer();
      await new Promise((r) => setTimeout(r, 50));
    }
    let s: DrawerSide = "right";
    try {
      s = await chooseSide();
    } catch {
      /* fall through with "right" */
    }
    setSide(s);
    setRailPx(window.innerWidth);
    // One instant frame grow (imperceptible: dark-on-dark), THEN mount the
    // drawer so its CSS slide is the only visible motion.
    try {
      await expandFrame(s);
    } catch {
      /* window API unavailable — drawer still usable, just no growth */
    }
    setDrawerAnim("in");
    setDrawer(d);
  }

  // A step can require a drawer to be open for its anchor to exist. Keyed
  // on the required drawer alone: re-running when `drawer` changes would
  // fight the user if they closed it deliberately mid-tour.
  const tourDrawer = tour.active?.step.drawer ?? null;
  useEffect(() => {
    if (!tourDrawer || drawer?.kind === tourDrawer) return;
    void openDrawer(tourDrawer === "org" ? { kind: "org", name: activeOrg } : { kind: tourDrawer });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourDrawer]);

  // Offer the first-run tour once, and only to someone with no orgs yet.
  // Gated on `orgsLoaded` so the empty array this starts with is not read
  // as "brand new user".
  useEffect(() => {
    if (orgsLoaded) tour.offerFirstRun(orgs.length > 0);
  }, [orgsLoaded, orgs.length, tour.offerFirstRun]);

  const orgProjects = activeOrg ? projects.filter((p) => p.org === activeOrg) : [];
  const orgAccounts = activeOrg ? accounts.filter((a) => a.org === activeOrg) : [];
  const error = orgsError ?? configError ?? stateError;

  const activeOrgObj = activeOrg ? orgs.find((o) => o.name === activeOrg) : null;
  const activeOrgNeedsLogin = !activeOrgObj || !isSessionAlive(activeOrgObj);

  const onStateChangeWithOrgRefresh = (s: typeof appState) => {
    replaceState(s);
    refreshOrgs();
  };

  return (
    <div
      className={`app-rail-shell side-${side}${drawer ? " has-drawer" : ""}`}
      style={drawer && railPx ? ({ "--rail-w": `${railPx}px` } as React.CSSProperties) : undefined}
    >
      <Rail
        devBuild={devBuild}
        orgs={orgs}
        activeOrg={activeOrg ?? ""}
        activeLoginName={activeLoginName}
        activeLoginProgress={activeLoginProgress}
        state={appState}
        projectCount={orgProjects.length}
        serviceCount={orgAccounts.length}
        activeDrawer={drawer?.kind ?? null}
        onSelectOrg={(name) => {
          setActiveOrg(name);
          // Dead session? The click IS the reconnect — start login
          // immediately instead of making the user find a button.
          const org = orgs.find((o) => o.name === name);
          if (!org || !isSessionAlive(org)) void login(name);
        }}
        onConfigureOrg={(name) => {
          setActiveOrg(name);
          void openDrawer({ kind: "org", name });
        }}
        onAddOrg={() => void openDrawer({ kind: "org", name: null })}
        highlightServices={highlightServices}
        onOpenProjects={() => void (drawer?.kind === "projects" ? closeDrawer() : openDrawer({ kind: "projects" }))}
        onOpenServices={() => {
          setHighlightServices(false);
          void (drawer?.kind === "services" ? closeDrawer() : openDrawer({ kind: "services" }));
        }}
        onOpenSettings={() => {
          setSettingsTab("orgs");
          void (drawer?.kind === "settings" ? closeDrawer() : openDrawer({ kind: "settings" }));
        }}
        onOpenHelp={() => {
          setSettingsTab("help");
          void (drawer?.kind === "settings" && settingsTab === "help"
            ? closeDrawer()
            : openDrawer({ kind: "settings" }));
        }}
        onDisengage={disengageProfiles}
        onDisengageAll={disengageEverything}
      />

      {drawer && (
        <Drawer title={drawerTitle(drawer)} side={side} anim={drawerAnim} onClose={() => void closeDrawer()}>
          {error && (
            <div className="error-banner">
              <span>{error}</span>
              <button
                onClick={() => {
                  clearOrgsError();
                  clearConfigError();
                  clearStateError();
                }}
              >
                ×
              </button>
            </div>
          )}

          {drawer.kind === "projects" && activeOrgObj && (
            <ProjectsDrawer
              org={activeOrgObj}
              accounts={orgAccounts}
              projects={orgProjects}
              state={appState}
              onStateChange={onStateChangeWithOrgRefresh}
              onTogglePin={togglePin}
              onCreateProject={upsertProject}
            />
          )}

          {drawer.kind === "services" && activeOrgObj && (
            <ServicesDrawer
              org={activeOrgObj}
              accounts={orgAccounts}
              state={appState}
              needsLogin={activeOrgNeedsLogin}
              onLogin={() => activeOrg && void login(activeOrg)}
              onStateChange={onStateChangeWithOrgRefresh}
              onImported={replaceAccounts}
              onSessionMaybeRefreshed={refreshOrgs}
            />
          )}

          {drawer.kind === "org" && (
            <OrgDrawer
              key={drawer.name ?? "__new__"}
              org={drawer.name ? orgs.find((o) => o.name === drawer.name) ?? null : null}
              loggingIn={activeLoginName === drawer.name}
              onSave={addOrg}
              onDelete={removeOrg}
              onSignOut={signOut}
              onLogin={(name) => void login(name)}
              onRefresh={(name) => void refreshOne(name)}
              onClose={() => void closeDrawer()}
              onAdded={(name, loginNow) => {
                setActiveOrg(name);
                setHighlightServices(true);
                void closeDrawer();
                if (loginNow) void login(name);
              }}
            />
          )}

          {drawer.kind === "settings" && (
            <SettingsView
              key={settingsTab}
              initialTab={settingsTab}
              isTourCompleted={tour.isCompleted}
              onStartTour={(id) => {
                // A tour points at the rail, which sits behind an open
                // drawer — close it first so step one is visible.
                void closeDrawer();
                tour.start(id);
              }}
              onResetTours={tour.resetAll}
              orgs={orgs}
              activeOrgName={activeOrg ?? ""}
              accounts={accounts}
              onBack={() => void closeDrawer()}
              onSaveOrg={addOrg}
              onDeleteOrg={removeOrg}
              onSignOutOrg={signOut}
              onSaveAccount={upsertAccount}
              onDeleteAccount={removeAccount}
            />
          )}
        </Drawer>
      )}

      {tour.active && (
        <TourOverlay active={tour.active} onNext={tour.next} onBack={tour.back} onDismiss={tour.dismiss} />
      )}
    </div>
  );
}
