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

---

## Install

```sh
brew install --cask mpurdon/tap/sleipnir
```

Apple Silicon only for now. The app isn't notarized yet — if Gatekeeper
objects on first launch, right-click the app and choose **Open**, or run:

```sh
xattr -dr com.apple.quarantine /Applications/sleipnir.app
```

## What it does

- **Auto-discovery** — one login, one scan: sleipnir lists every account in
  your AWS organization and groups them into *services* from their naming
  convention (`Core Services Development/Staging/Production/Sandbox` → one
  service, four environments), with per-environment role picks in a review
  table before anything is imported.
- **Projects** — bundle the services you work on together and engage them
  as a unit: one click fetches role credentials for every member and wires
  `~/.aws/config` profiles via `credential_process`. Your terminals just
  work: `aws sts get-caller-identity --profile core-services`.
- **Honest sessions** — the SSO refresh token lives in the macOS Keychain
  and the hourly access token rotates silently in the background; the only
  login you ever see is your org's real SSO session boundary. Terminals
  self-heal headlessly through the bundled `sleipnir creds` resolver.
- **Safety by construction** — DISENGAGE is a real off-switch (a
  disengaged profile refuses to resolve even though its config stanza
  remains); admin-on-production requires a press-and-hold, never a
  dismissable dialog; mode fallback (admin → poweruser → readonly) never
  escalates and the UI always shows the access you actually got.
- **Plays well with others** — the `~/.aws/config` editor is
  line-preserving and byte-faithful around stanzas it doesn't own, and it
  neutralizes (reversibly comments out) credential keys that would
  silently outrank `credential_process`.
- **⚡ Connection test** — verifies a profile through the *real* path:
  the AWS CLI reading your config, invoking `credential_process`, hitting
  STS — with the resulting ARN shown in-app.

## Development

Bun end-to-end (no Vite), Tauri 2, React 19, Rust.

```sh
bun install
bun run tauri dev     # dev app with hot reload
bun run tauri build   # release .app bundle
cargo test            # run from src-tauri/ — includes the discovery
                      # heuristic's structure-preserving 166-account fixture
```

## Status

Early but daily-driven. Roadmap: signing/notarization, universal (Intel)
builds, Windows packaging, release automation.
