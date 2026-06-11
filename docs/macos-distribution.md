# macOS Distribution Builds

How to produce a signed, notarized macOS build of Reflect for distribution outside the
Mac App Store.

```bash
pnpm release:macos setup   # once: store notarization credentials in the keychain
pnpm release:macos         # signed + notarized build, verified end to end
```

The helper lives at `apps/desktop/scripts/release-macos.mjs` and is exposed as
`pnpm release:macos` from the repo root.

## What you need

1. **A Developer ID Application certificate** in your login keychain. This certificate
   type (not "Apple Distribution", which is App Store only) is required for distribution
   outside the App Store, and only the Apple Developer **Account Holder** can create one,
   at [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates).
   Confirm it's installed with:

   ```bash
   security find-identity -v -p codesigning
   ```

2. **An Apple ID on the team with an app-specific password** for notarization. Create the
   password at [account.apple.com](https://account.apple.com) → Sign-In and Security →
   App-Specific Passwords, then run `pnpm release:macos setup`. The setup command stores
   it in your login keychain (item `reflect-notary`) — the password never touches shell
   history or the repo.

3. **Xcode Command Line Tools** (`xcode-select --install`) for `notarytool` and `stapler`.

Nothing signing-related is committed to the repo: contributors without the certificate
can still build unsigned bundles with plain `pnpm tauri build`.

## What `pnpm release:macos` does

1. Auto-detects the Developer ID identity from the keychain and derives the team ID.
2. Loads notarization credentials (keychain item, or environment variables — see CI below).
3. Runs `pnpm tauri build`, which stages the `reflect` CLI sidecar, then signs inside-out
   (sidecar → main binary → `.app`) with hardened runtime, notarizes the `.app` via
   `notarytool`, staples the ticket, and builds + signs the DMG.
4. Notarizes and staples the **DMG** itself. Tauri only notarizes the `.app`; without its
   own ticket the DMG container fails `spctl --type open` and downloads can hit
   Gatekeeper friction.
5. Verifies everything — `codesign --verify --deep --strict`, Gatekeeper assessment of
   the app and DMG (`accepted` / `source=Notarized Developer ID`), and stapled tickets —
   and fails loudly if any check is off.

Bundles land in `target/release/bundle/macos/Reflect.app` and
`target/release/bundle/dmg/Reflect_<version>_<arch>.dmg`.

## Commands and flags

```bash
pnpm release:macos                 # build + notarize + verify (default)
pnpm release:macos setup           # store Apple ID + app-specific password in the keychain
pnpm release:macos verify          # re-run all checks on already-built bundles
pnpm release:macos --no-notarize   # signed-only build (runs locally; Gatekeeper rejects it elsewhere)
```

## CI

Everything the script auto-detects can be supplied via environment variables instead,
which take precedence over the keychain:

| Variable | Purpose |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full identity string, e.g. `Developer ID Application: … (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID notarization (app-specific password) |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` | App Store Connect API key notarization (preferred for CI — not tied to a personal Apple ID) |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | base64 `.p12` + password; Tauri imports it into a temporary keychain on runners with no cert installed |

See the [Tauri macOS signing docs](https://v2.tauri.app/distribute/sign/macos/) for the
runner keychain setup.

## Troubleshooting

- **`no "Developer ID Application" certificate found`** — the cert isn't in your *login*
  keychain, or it's the wrong type. An invalid/incomplete cert won't show up in
  `security find-identity` at all.
- **Notarization fails (`status: Invalid`)** — the script automatically prints the notary
  log, which lists each offending file. Common cause: a binary that wasn't signed with
  hardened runtime.
- **`rejected, source=Unnotarized Developer ID`** — signing worked but the artifact has no
  notarization ticket; rerun without `--no-notarize`.
- **Notarization hangs** — Apple's service occasionally queues submissions for a long
  time; check status with `xcrun notarytool history --apple-id <id> --team-id <team>`.

## Current limitations

- Builds target the host architecture only (Apple Silicon in practice). A universal
  build needs the `x86_64-apple-darwin` rustup target, a universal sidecar from
  `scripts/build-sidecar.mjs`, and `pnpm tauri build --target universal-apple-darwin`.
- The iOS project template (`src-tauri/ios.project.yml`) still uses the pre-rename bundle
  identifier and needs its own provisioning pass.
- Updater-artifact signing (`TAURI_SIGNING_PRIVATE_KEY`) is separate from Apple signing
  and not yet set up; it becomes relevant if we adopt Tauri's updater plugin.
