import type { Tour } from "./types";

/** Where the full written docs live. Also linked from the help panel. */
export const DOCS_URL = "https://mpurdon.github.io/sleipnir/";

/**
 * The guided tours, in the order the help panel lists them.
 *
 * Copy rules, learned the hard way from the rail being 380px wide: a title
 * of four words or fewer, and a body of one or two sentences. Anything
 * longer stops being a pointer at a control and becomes a document — and
 * the document already exists at DOCS_URL.
 *
 * Steps say what a control is *for*, not what it is called. "SERVICES is
 * where your scanned org lives" earns its place; "this is the SERVICES
 * button" does not.
 */
export const TOURS: Tour[] = [
  {
    id: "first-run",
    title: "First run",
    blurb: "The rail, your first org, and the one-scan setup.",
    length: "6 steps",
    steps: [
      {
        title: "Welcome to Sleipnir",
        body: "Sleipnir turns your AWS organization into services you can switch on and off. One login, one scan, then a click to work. This takes about a minute.",
      },
      {
        anchor: "rail-orgs",
        title: "Your organizations",
        body: "Each org is one AWS IAM Identity Center. Most people have exactly one. The lamp shows session health: green is alive, gold is under 30 minutes, red means log in again.",
      },
      {
        anchor: "rail-add-org",
        title: "Add an org",
        body: "You need your SSO start URL and the region Identity Center is hosted in — not the region your workloads run in. That trips most people up once.",
      },
      {
        anchor: "rail-services",
        title: "Scan for services",
        body: "SERVICES is where your org gets discovered. One scan groups your accounts into services by their naming convention, and shows you the result before writing anything.",
      },
      {
        anchor: "rail-projects",
        title: "Bundle into projects",
        body: "A project is the set of services one piece of work touches. Engaging it fetches credentials for all of them at once.",
      },
      {
        anchor: "rail-engaged",
        title: "What is live, always visible",
        body: "Everything currently engaged shows here, with production in red. Disengaging removes the keys from ~/.aws/credentials — a real off-switch, not a flag.",
      },
    ],
  },

  {
    id: "discovery",
    title: "Discovery & import",
    blurb: "How the scan groups accounts, and what to check before importing.",
    length: "5 steps",
    steps: [
      {
        title: "One scan, not a spreadsheet",
        body: "Sleipnir reads your org rather than asking you to describe it. Accounts named 'Core Services Development/Staging/Production' become one service with three environments.",
      },
      {
        drawer: "services",
        anchor: "discovery-scan",
        title: "Run the scan",
        body: "This lists every account your SSO assignment grants you and fetches the roles on each. A large org takes a minute; the meter counts real progress.",
        skipIfMissing: true,
      },
      {
        drawer: "services",
        anchor: "services-rescan",
        title: "Re-scan any time",
        body: "Run it again when your org changes. Re-scanning merges updates, so your renames, role picks and project memberships survive.",
        skipIfMissing: true,
      },
      {
        drawer: "services",
        title: "Review before importing",
        body: "Nothing is written until you press IMPORT. Each row is one service; the grey chips are its environments, and the small name is the AWS profile you will type.",
      },
      {
        drawer: "services",
        title: "⚠ PICK ROLE is not an error",
        body: "It means two roles map to the same mode. A sensible default is already chosen — expand the row only if you want the other one. Picks are per-environment.",
      },
    ],
  },

  {
    id: "projects",
    title: "Projects",
    blurb: "Bundle the services you work on together and engage them at once.",
    length: "4 steps",
    steps: [
      {
        drawer: "projects",
        title: "One click, every account",
        body: "A project is a named bundle of services. Engaging it fetches credentials for every member at the same environment and mode.",
      },
      {
        drawer: "projects",
        anchor: "projects-new",
        title: "Create one",
        body: "Name it after the work — 'checkout-rewrite' — not the infrastructure. The point is a button that matches what you are actually doing.",
        skipIfMissing: true,
      },
      {
        drawer: "projects",
        anchor: "project-engage",
        title: "Engage the bundle",
        body: "The button always names what it will do. One member failing never blocks the rest — you get the working subset and a note about the one that did not make it.",
        skipIfMissing: true,
      },
      {
        drawer: "projects",
        anchor: "project-pin",
        title: "Pin what you use daily",
        body: "Pinned projects sort to the top. Everything else orders by how recently you engaged it, so the list stays roughly in the order you work.",
        skipIfMissing: true,
      },
    ],
  },

  {
    id: "engaged",
    title: "Using credentials",
    blurb: "Copy connection details, test a profile for real, and stand down.",
    length: "5 steps",
    steps: [
      {
        title: "Real keys, everywhere",
        body: "Engaging writes static keys into ~/.aws/credentials. Terminals, every SDK, IDE plugins and sandboxed apps all work with no extra setup: aws sts get-caller-identity --profile <alias>.",
      },
      {
        anchor: "rail-chip",
        title: "Click a profile for details",
        body: "Profile name, account, region and role — each one click-to-copy.",
        skipIfMissing: true,
      },
      {
        anchor: "rail-chip",
        title: "⚡ Test connection",
        body: "Runs the real AWS CLI against STS through your actual config. Nothing is simulated, so a pass means it genuinely works and a failure is the message AWS returned.",
        skipIfMissing: true,
      },
      {
        title: "Credentials stay fresh",
        body: "Engaged profiles refresh in the background before they expire, so a terminal left open overnight still works — right up to your org's real SSO session boundary.",
      },
      {
        anchor: "rail-disengage-all",
        title: "Standing down",
        body: "Disengaging physically removes the keys from ~/.aws/credentials. A script that runs afterwards finds nothing, because there is nothing.",
        skipIfMissing: true,
      },
    ],
  },

  {
    id: "safety",
    title: "Safety on production",
    blurb: "Press-and-hold, mode fallback, and why production is always red.",
    length: "4 steps",
    steps: [
      {
        title: "Safety by construction",
        body: "Sleipnir makes production admin easy to hold, which is useful and dangerous. Several behaviours exist to keep the dangerous case deliberate — none of them is a dialog you can dismiss.",
      },
      {
        title: "Press and hold for PRD admin",
        body: "Admin on production needs a sustained press, not a click. A confirmation box is defeated by reflex; a held button cannot be pressed by accident. Every other combination is an ordinary click.",
      },
      {
        title: "Fallback never escalates",
        body: "Ask for a mode you do not have and Sleipnir degrades: admin, then poweruser, then readonly — and shows the access you actually got. Asking for less never gets you more.",
      },
      {
        anchor: "rail-engaged",
        title: "Production is loud",
        body: "Production is red everywhere it appears, whatever the mode. You never have to read carefully to notice it is on.",
      },
    ],
  },
];

export function tourById(id: string): Tour | undefined {
  return TOURS.find((t) => t.id === id);
}
