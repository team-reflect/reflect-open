# macOS Distribution Builds

How to produce a signed, notarized macOS build of Reflect for distribution outside the
Mac App Store.

```bash
pnpm release:macos setup           # once: store notarization credentials in the keychain
pnpm release:macos setup-updater   # once: generate the auto-update signing keypair
pnpm release:macos                 # signed + notarized build, verified end to end
pnpm release:macos publish         # the above, then upload the DMG + updater artifacts to a new GitHub release
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

4. **The updater signing key** (for `publish`). Auto-update payloads are verified against
   the minisign public key committed in `tauri.conf.json` (`plugins.updater.pubkey`) —
   distinct from Apple signing. `pnpm release:macos setup-updater` generates the keypair,
   stores the private key in your login keychain (item `reflect-updater`), and prints the
   public key to commit. **Losing the private key strands every installed app** (they
   reject anything not signed with it), so back it up; rotating it only reaches users via
   a release signed with the old key that ships the new pubkey.

Nothing signing-related is committed to the repo: contributors without the certificate
can still build unsigned bundles with plain `pnpm tauri build`.

## What `pnpm release:macos` does

1. Auto-detects the Developer ID identity from the keychain and derives the team ID.
2. Loads notarization credentials (keychain item, or environment variables — see
   [Releasing from CI](#releasing-from-ci) below).
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
pnpm release:macos publish         # build + notarize + verify, then create a GitHub release
pnpm release:macos publish --draft # same, but leave the release as a draft for review
pnpm release:macos --no-notarize   # signed-only build (runs locally; Gatekeeper rejects it elsewhere)
```

## Publishing to GitHub Releases

`pnpm release:macos publish` runs the full build above, then creates a GitHub release
tagged `v<version>` (the `version` in `apps/desktop/src-tauri/tauri.conf.json`) with the
notarized DMG, the updater artifacts (`Reflect.app.tar.gz` + `.sig`), and the
`latest.json` manifest attached, plus auto-generated release notes. Installed apps poll
`releases/latest/download/latest.json` (the committed `plugins.updater.endpoints` URL),
so publish requires the updater key and always attaches the manifest — a release without
it would stop existing installs from seeing any future updates. Beyond the signing
requirements, it needs the [GitHub CLI](https://cli.github.com) authenticated with
`gh auth login`.

All preflight checks run before the build, so a doomed publish fails in seconds rather
than after notarization:

- the working tree is clean and `HEAD` is on an `origin` branch — the release tag is
  created at that exact commit;
- no release for `v<version>` exists yet, and any existing `v<version>` tag on origin
  points at `HEAD` (`gh` reuses an existing tag, which would release the wrong commit).
  Publishing a new release means bumping `version` in `tauri.conf.json` first (keep
  `src-tauri/Cargo.toml` in step).

Pass `--draft` to create the release without publishing it, then review and publish it
from the GitHub UI.

## Beta releases

Development happens on `next` (the repo default branch); `master` only advances when
`next` is merged into it for a public release. On `next`, `version` in
`tauri.conf.json` carries a prerelease suffix (e.g. `0.2.0-beta.1`), and `publish`
turns that suffix into a GitHub **pre-release** automatically. `releases/latest` — the
committed updater endpoint — ignores pre-releases, so stable installs never see a
beta.

Beta installs poll that same stable endpoint: they get offered the next stable release
when it ships, but not newer betas. A dedicated beta updater channel is future work.

Cutting a beta is the normal release flow on `next`: bump the prerelease version
(`0.2.0-beta.2`, …) in `tauri.conf.json` + `src-tauri/Cargo.toml`, then run the
Release workflow on `next`. For a stable release, merge `next` into `master`, set a
stable version there (e.g. `0.2.0`), and run the workflow on `master`.

## Releasing from CI

`.github/workflows/release.yml` runs `pnpm release:macos publish` on a GitHub-hosted
macOS runner — the same pipeline as a local release, including DMG notarization, the
Gatekeeper checks, and the updater artifacts. Trigger it from **Actions → Release →
Run workflow** (tick *draft* to review the release before publishing), or by pushing
the matching `v<version>` tag. The publish preflights apply unchanged, so bump
`version` in `tauri.conf.json` (and `src-tauri/Cargo.toml`) on the released branch
first.

The script reads all signing material from environment variables, which take
precedence over the keychain (exporting them works for local releases too); the
workflow wires them from repository Actions secrets of the same names. Create these
under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full identity string, e.g. `Developer ID Application: … (TEAMID)` — from `security find-identity -v -p codesigning` |
| `APPLE_CERTIFICATE` | The Developer ID certificate + private key: export a `.p12` from Keychain Access, then `base64 -i certificate.p12`. Tauri imports it into a temporary keychain on the runner |
| `APPLE_CERTIFICATE_PASSWORD` | The password set on that `.p12` export |
| `APPLE_API_KEY` | App Store Connect API key ID, for notarization (preferred in CI — not tied to a personal Apple ID) |
| `APPLE_API_ISSUER` | The API key's issuer UUID |
| `APPLE_API_KEY_CONTENT` | The `.p8` key file's content; the workflow stages it on disk and sets `APPLE_API_KEY_PATH`, the variable the script reads |
| `TAURI_SIGNING_PRIVATE_KEY` | The updater private key: `security find-generic-password -s reflect-updater -w \| base64 --decode` |

Notes:

- Apple ID notarization works instead of the API key: set `APPLE_ID` +
  `APPLE_PASSWORD` (an app-specific password), plus `APPLE_TEAM_ID` if the signing
  identity doesn't end in `(TEAMID)`.
- Leave `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` unset: the key has no password, GitHub
  rejects empty-string secrets, and the workflow defaults it to empty. (Locally,
  `TAURI_SIGNING_PRIVATE_KEY_PATH` also works in place of the key content.)
- No PAT is needed — the release is created with the workflow's own `GITHUB_TOKEN`.

The workflow verifies the secrets before building, so a misconfigured runner fails in
seconds rather than after the build and notarization. See the
[Tauri macOS signing docs](https://v2.tauri.app/distribute/sign/macos/) for background
on the runner keychain setup.

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
- `latest.json` only lists the host architecture, so auto-update serves the arch that was
  built (Apple Silicon in practice); the universal-build work above lifts both limits.
