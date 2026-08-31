<p align="center">
  <img src="src/assets/sleipnir-mark.png" alt="Sleipnir" width="360" />
</p>
<p align="center">
  <img src="src/assets/sleipnir-wordmark.png" alt="SLEIPNIR" width="280" />
</p>

<p align="center">
  A Norse-themed AWS SSO credential manager for macOS — a Leapp replacement<br/>
  that wires itself up from your org's naming conventions.
</p>

<p align="center">
  <img src="docs/screenshot-services.png" alt="Services drawer with a service expanded: profile editor, env/mode selection, and the press-and-hold engage button" width="820" />
</p>

---

## Install

```sh
brew install --cask mpurdon/tap/sleipnir-aws
```

Apple Silicon only for now. Signed and notarized — no Gatekeeper
workarounds needed.

📖 **[Help docs →](https://mpurdon.github.io/sleipnir/)** — getting started,
discovery, projects, safety, and troubleshooting. The app carries the same
walkthroughs as guided tours under **⚙ SETTINGS → HELP**.

## What it does

- **Auto-discovery** — one login, one scan: sleipnir lists every account in
  your AWS organization and groups them into *services* from their naming
  convention (`Core Services Development/Staging/Production/Sandbox` → one
  service, four environments), with per-environment role picks in a review
  table before anything is imported.
- **Projects** — bundle the services you work on together and engage them
  as a unit: one click fetches role credentials for every member and
  delivers them as profiles in `~/.aws/credentials` — so terminals, SDKs,
  IDE plugins, and even sandboxed apps just work:
  `aws sts get-caller-identity --profile core-services`.
- **Honest sessions** — the SSO refresh token lives in the macOS Keychain,
  the hourly access token rotates silently, and engaged profiles' keys are
  refreshed in the background before they expire; the only login you ever
  see is your org's real SSO session boundary.
- **Safety by construction** — DISENGAGE is a real off-switch (the keys
  are physically removed from `~/.aws/credentials`); admin-on-production
  requires a press-and-hold, never a dismissable dialog; mode fallback
  (admin → poweruser → readonly) never escalates and the UI always shows
  the access you actually got.
- **Plays well with others** — the `~/.aws/config` editor is
  line-preserving and byte-faithful around stanzas it doesn't own, and it
  neutralizes (reversibly comments out) credential keys that would
  silently override an engagement.
- **⚡ Connection test** — verifies a profile through the *real* path:
  the AWS CLI reading your config and hitting STS — with the resulting
  ARN shown in-app.

<table>
  <tr>
    <td align="center" width="34%">
      <img src="docs/screenshot-rail.png" alt="The compact rail: orgs with live session countdowns, projects/services drawers, and engaged profiles grouped by project" />
      <br/><sub>The rail — orgs, drawers, and everything currently engaged</sub>
    </td>
    <td align="center" width="66%">
      <img src="docs/screenshot-test.png" alt="Connection test modal showing a live CONNECTED result with account, ARN, and latency" />
      <br/><sub>⚡ Connection test — a real <code>sts get-caller-identity</code> round-trip</sub>
    </td>
  </tr>
</table>

## Development

Bun end-to-end (no Vite), Tauri 2, React 19, Rust.

```sh
bun install
bun run tauri dev     # dev app with hot reload
bun run tauri build   # release .app bundle
cargo test            # run from src-tauri/ — includes the discovery
                      # heuristic's structure-preserving 166-account fixture

bun run docs:serve    # help site at http://127.0.0.1:4318
```

The help site is Markdown in `docs-src/`, built by `scripts/build-docs.ts`
and deployed to GitHub Pages on push. In-app tours live in `src/tour/`.

## Status

Early but daily-driven. Signed and notarized, with tag-driven releases
that publish to the Homebrew tap automatically. Roadmap: universal
(Intel) builds, Windows packaging.
