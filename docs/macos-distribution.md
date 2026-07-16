# macOS Distribution Builds

How to produce a signed, notarized macOS build of Reflect for distribution outside the
Mac App Store.

```bash
pnpm release:macos setup           # once: store notarization credentials in the keychain
pnpm release:macos setup-updater   # once: generate the auto-update signing keypair
pnpm release:macos                 # signed + notarized build for this Mac's architecture
pnpm release:macos publish         # build Apple Silicon + Intel, then publish both DMGs
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

5. **Sentry exception telemetry credentials.** Set the public `VITE_SENTRY_DSN` and the
   private, build-only `SENTRY_AUTH_TOKEN` for local release builds. Configure them in
   GitHub as the repository secrets `SENTRY_DSN` and `SENTRY_AUTH_TOKEN`; release CI
   requires both so packaged builds cannot silently ship without JavaScript diagnostics
   or readable source-mapped stacks. The token needs release/source-map upload scope only
   and must never use the `VITE_` prefix or enter an app bundle.

Nothing signing-related is committed to the repo: contributors without the certificate
can still build unsigned bundles with plain `pnpm tauri build`.

## What `pnpm release:macos` does

1. Auto-detects the Developer ID identity from the keychain and derives the team ID.
2. Loads notarization credentials (keychain item, or environment variables — see
   [Releasing from CI](#releasing-from-ci) below).
3. Runs `pnpm tauri build --target <target> --bundles app`, which stages the `reflect`
   CLI sidecar for that target and signs the app bundle. The release helper then
   re-signs the bundled sidecars without the app's restricted entitlements, re-signs the
   `.app` with its entitlement file plus the flavor-specific identity entitlements from
   its embedded provisioning profile, notarizes the finalized `.app` via `notarytool`,
   staples the ticket, and verifies the signed identity entitlements and sidecars.
   Intel builds also download Microsoft's official ONNX Runtime macOS x86_64 archive
   into `src-tauri/resources/onnxruntime/` and bundle `libonnxruntime.dylib` as a
   Tauri resource before signing; that directory is generated and gitignored.
4. Creates the updater `.app.tar.gz` from the finalized app and signs it with the Tauri
   updater key.
5. Builds and signs the DMG directly from the notarized app. In CI, the release helper
   imports `APPLE_CERTIFICATE` into its own temporary keychain for the final app and DMG
   signing steps. The helper avoids Tauri's generated Finder-layout DMG script because
   that script is brittle on GitHub-hosted macOS images.
6. Notarizes and staples the **DMG** itself. Without its
   own ticket the DMG container fails `spctl --type open` and downloads can hit
   Gatekeeper friction.
7. Verifies everything — `codesign --verify --deep --strict`, sidecar launch, Gatekeeper
   assessment of the app and DMG (`accepted` / `source=Notarized Developer ID`), and
   stapled tickets — and fails loudly if any check is off.

Bundles land under `target/<target-triple>/release/bundle/`, for example
`target/aarch64-apple-darwin/release/bundle/macos/Reflect.app` and
`target/x86_64-apple-darwin/release/bundle/dmg/Reflect_<version>_x86_64.dmg`.

## Commands and flags

```bash
pnpm release:macos                 # build + notarize + verify (default)
pnpm release:macos --target=x86_64-apple-darwin  # build + notarize + verify for Intel
pnpm release:macos setup           # store Apple ID + app-specific password in the keychain
pnpm release:macos verify          # re-run all checks on already-built bundles
pnpm release:macos publish         # build + notarize + verify, then create a GitHub release
pnpm release:macos sync-beta-feed  # retry moving beta downloads/feed from the tagged release
pnpm release:macos publish --draft # same, but leave the release as a draft for review
pnpm release:macos --no-notarize   # signed-only build (runs locally; Gatekeeper rejects it elsewhere)
```

CI uses `build --target=<triple> --artifact-dir=<dir>` for each architecture, then
`publish --defer-beta-feed --from-artifacts=<dir>` after downloading both artifact
sets. A separate `sync-beta-feed` job refreshes moving beta downloads after the tagged
release is published, so that final step can be retried without rebuilding or
republishing. Local `publish` runs the same sync before returning unless explicitly
deferred.

## Cutting a release (Release PRs)

The version lives in one place: `version` in `apps/desktop/package.json`.
`tauri.conf.json` points its `version` at that file, the crate version in
`src-tauri/Cargo.toml` is frozen at `0.0.0`, and `Cargo.lock` never changes for a
release. release-please maintains the version: on every push to `master`,
`.github/workflows/release-please.yml` runs two release-please passes (one per
channel) that keep two **Release PRs** open side by side:

- The **beta** Release PR (`chore: release X.Y.Z-beta.N`) bumps
  `apps/desktop/package.json`, advances `.github/release-please/manifest.beta.json`,
  and prepends `apps/desktop/CHANGELOG.beta.md` with the conventional-commit PR titles
  landed since the last beta release.
- The **stable** Release PR (`chore: release X.Y.Z`) does the same with
  `manifest.stable.json` and `apps/desktop/CHANGELOG.md`, aggregating everything since
  the last stable release. It also advances `manifest.beta.json` to the stable
  version, so the next beta cycle starts above the released version.

**Merging a Release PR is the release, and the merge is the only human action.** Both
Release PRs squash-merge (the default). release-please then creates a draft GitHub
release (with its `v<version>` tag — `force-tag-creation`, so later release-please
runs can always anchor on the previous release) and hands the tag name to the Release
workflow, which builds, signs, notarizes, uploads the assets, and undrafts the
release. Nothing is visible to users (and `releases/latest` does not move) until
every asset is in place. The workflow resolves the release tag to its immutable
commit once; the macOS, TestFlight, and feed sync jobs all check out that SHA rather
than resolving a tag name independently.

PRs created with `GITHUB_TOKEN` do not start `pull_request` workflows, so checks do
not appear automatically on the bot-created Release PRs. Use the run-checks button
before merging one.

### Beta (the everyday release)

1. Land PRs on `master` as usual.
2. When it's time to ship, open the beta Release PR (`chore: release X.Y.Z-beta.N`),
   polish the changelog if needed (edit the PR branch — release-please regenerates the
   PR when new commits land, so polish last), and **merge it**.
3. Everything else is automatic, ending with the `updater-beta` feed refresh and the
   TestFlight upload. Installed Reflect Beta apps pick up the update.
4. The stable Release PR stays open and is rebased by the next push; merge it whenever
   the channel is ready to graduate.

### Stable

1. Review the stable Release PR (`chore: release X.Y.Z`). Its changelog aggregates
   every change since the last stable release, including everything already shipped
   in betas.
2. Run its checks, then **merge it** (squash, like any Release PR). The same pipeline
   publishes the stable flavor and `releases/latest` moves.
3. The merge supersedes the open beta Release PR: its diff now conflicts with
   `master`, so it cannot merge by accident. Leave it alone; the next releasable
   commit rewrites it in place to the next beta version (release-please reuses the
   per-channel head branch). Closing it by hand is harmless.

The stable release builds `master` as of the stable Release PR's merge, which may
include commits that never shipped in a beta. To ship a beta-tested snapshot, merge
the stable Release PR right after a healthy beta, before landing new work.

If macOS publishing or TestFlight fails after a Release PR merged, the tag and GitHub
release record already exist (the release may still be a draft): rerun
**Actions → Release** or **Actions → TestFlight** on the release commit as
appropriate.

### Hotfix

A hotfix is a normal PR: land the `fix:` on `master`, then merge the stable Release
PR that now offers the patch release. If `master` already carries unreleased work
that must not ship in the fix, there is no Release PR shortcut: branch from the
released tag, cherry-pick the fix, bump `version` in `apps/desktop/package.json` on
that branch, run the manual fallback below on it, and land the fix on `master` as
usual.

### Release automation files

Each release-please state file is owned by one channel:

| File | Written by |
| --- | --- |
| `.github/release-please/config.beta.json` | humans |
| `.github/release-please/manifest.beta.json` | the beta Release PR, plus the stable Release PR (advancing it to the stable version) |
| `.github/release-please/config.stable.json` | humans |
| `.github/release-please/manifest.stable.json` | the stable Release PR |
| `apps/desktop/CHANGELOG.beta.md` | the beta Release PR |
| `apps/desktop/CHANGELOG.md` | the stable Release PR |

The manifests are the per-channel source of truth for "last released version". Both
Release PRs write `apps/desktop/package.json` (`version`); whichever merges second is
regenerated on the next push, so there is nothing to reconcile by hand. Do not
hand-edit the changelogs or manifests outside the flows above, and do not use
`Release-As:` commit footers: human version interventions go through the manifest
files (the no-Release-PR fallback below is the explicit exception), and a major
graduation such as `1.0.0` is a one-time `release-as` in both config files. The first beta of
a new cycle is tagged without a number (`v0.6.0-beta`, then `-beta.1`, `-beta.2`, …)
— a release-please naming quirk, not a bug.

### Manual fallback (no Release PR)

For this exceptional recovery path, merge a PR that sets `version` in
`apps/desktop/package.json`, then run
**Actions → Release → Run workflow** on that branch. The workflow derives the tag from
the version, and publish creates the release (and its tag) itself via
`gh release create`. Afterwards, sync that channel's manifest file with a follow-up PR
so release-please continues from the right version.

## Publishing to GitHub Releases

`pnpm release:macos publish` runs the full build above for both supported macOS targets
(`aarch64-apple-darwin` for Apple Silicon and `x86_64-apple-darwin` for Intel), then
publishes the release tagged `v<version>` (the `version` in
`apps/desktop/package.json`): normally by filling and undrafting the draft release that
release-please created when the Release PR merged, or — when no release exists — by
creating one itself. The release carries two notarized DMGs, two
updater archives (one per architecture, each with its `.sig`), and a single
`latest.json` manifest with both `darwin-aarch64` and `darwin-x86_64` platform entries.
Published DMGs use fixed names (`Reflect_aarch64.dmg` and `Reflect_x86_64.dmg`
for stable) because the release tag already identifies the version. That keeps
`releases/latest/download/<asset>` stable across releases. Updater archives remain
versioned because each manifest points at an immutable release payload.
Stable installs poll `releases/latest/download/latest.json`; beta installs poll
`releases/download/updater-beta/latest.json`, a moving feed release that points at the
newest published beta. Publish requires the updater key and always attaches the
manifest — a release without it would stop existing installs from seeing any future
updates. Beyond the signing
requirements, it needs the [GitHub CLI](https://cli.github.com) authenticated with
`gh auth login`.

All preflight checks run before the build, so a doomed publish fails in seconds rather
than after notarization:

- the working tree is clean and `HEAD` is on an `origin` branch — the release tag is
  created at that exact commit;
- the `v<version>` release, when it already exists, is the asset-less draft created by
  release-please and targets `HEAD` (publish fills and undrafts it); a release that
  already carries artifacts, or a stray `v<version>` tag pointing at another commit,
  fails the preflight. Publishing again means bumping `version` in
  `apps/desktop/package.json` (via a Release PR) first.

Pass `--draft` to create the release without publishing it, then review and publish it
from the GitHub UI.

## Beta releases

Between stable releases, `version` in `apps/desktop/package.json` carries a
prerelease suffix (e.g. `0.7.0-beta.3`), and `publish` turns that suffix into a
GitHub **pre-release** automatically. `releases/latest` ignores pre-releases, so
stable installs never see a beta.

Beta builds use the dedicated `updater-beta` release instead. Every non-draft beta
publish replaces its `latest.json`, `Reflect.Beta_aarch64.dmg`, and
`Reflect.Beta_x86_64.dmg` assets with `--clobber`. The fixed DMG names give the README
permanent fresh-install links, while the manifest still points installed apps at the
immutable versioned updater archives. Draft beta releases do not update the moving
assets. The DMGs are replaced before `latest.json`; if that downstream job fails, rerun
only **Sync beta downloads and updater feed** to recover from the tagged release. The
sync compares its source with the immutable published beta releases: same-version
retries repair partial uploads, while a retry for an older release becomes a no-op
rather than rolling the channel back.

The channel is picked by the version string alone: a `-beta.N` prerelease publishes to
the beta feed, a plain version to the stable feed. The beta and dev flavor overlays pin
their own feeds, and `release-macos.mjs` pins the stable feed into stable builds at
build time, so releases are branch-independent.

Cutting a beta means merging the beta Release PR; a stable release means merging the
stable Release PR (see [Cutting a release](#cutting-a-release-release-prs) above).

## Build flavors (Reflect / Reflect Beta / Reflect Dev)

Three flavors ship as distinct, coexisting apps:

| Flavor       | Version        | productName  | identifier                 | Icon         | Updater feed      |
| ------------ | -------------- | ------------ | -------------------------- | ------------ | ----------------- |
| Reflect      | `X.Y.Z`        | Reflect      | `app.reflect.desktop`      | blue/violet  | `releases/latest` |
| Reflect Beta | `X.Y.Z-beta.N` | Reflect Beta | `app.reflect.desktop.beta` | purple/violet | `updater-beta`    |
| Reflect Dev  | local builds   | Reflect Dev  | `app.reflect.desktop.dev`  | green        | `updater-dev-noop` (no-op) |

The base `tauri.conf.json` is the stable flavor and uses the shipped gradient icon
(`icons/`). Beta and dev are config overlays (`src-tauri/tauri.beta.conf.json`,
`src-tauri/tauri.dev.conf.json`) merged with `--config`; their icons are the same
artwork recolored via `magick -modulate` (beta `104,100,120`, dev `92,100,231`; see
`src-tauri/icons/README.md`). `release:macos` picks the flavor from the version
(prerelease → beta, else stable), so a release always matches the updater feed compiled
into it; `release.yml` needs no flavor knowledge.

Each overlay pins its own updater feed so the flavor is self-consistent regardless of the
base config's channel: beta → `updater-beta`, dev → a deliberately non-existent
`updater-dev-noop` feed so dev builds never find an update (in `tauri dev` the updater is
off anyway). The stable feed is pinned into stable builds at build time by
`release-macos.mjs` (the committed base config points at the beta feed).

Distinct identifiers give each flavor its own webview storage and embeddings cache.
Settings, recent graphs and keychain secrets are currently **shared** across flavors (the
`reflect-open` config dir and keychain service are hardcoded, not derived from the
identifier).

Local builds:

```bash
pnpm tauri:dev                                   # run Reflect Dev (green), isolated identifier
pnpm tauri:build:dev                             # bundle Reflect Dev
pnpm tauri:build:beta                            # bundle Reflect Beta locally (unsigned)
pnpm release:macos --flavor=beta --no-notarize   # signed-only beta, for local checks
```

Because GitHub rewrites spaces in uploaded asset names to dots, the updater manifest URL
for "Reflect Beta" is sanitized to `Reflect.Beta.app.tar.gz` in `writeUpdaterManifest`.
Do not "fix" the space back, or beta auto-update 404s.

**Beta tester migration (one-time):** before flavors, beta builds were a plain "Reflect"
(`app.reflect.desktop`) that merely polled the beta feed. The first flavored beta is a new
app (`app.reflect.desktop.beta`, "Reflect Beta"), so existing beta installs do not migrate
cleanly. Tell testers to delete the old "Reflect" beta and install "Reflect Beta" fresh.
Stable installs are unaffected (same identifier and the shipped icon).

## Releasing from CI

`.github/workflows/release.yml` first runs the publish preflights, then builds two
signed/notarized macOS artifacts in parallel:

- Apple Silicon: `macos-26`, `--target=aarch64-apple-darwin`
- Intel: `macos-26`, `--target=x86_64-apple-darwin`

Each build job runs the same DMG notarization, Gatekeeper checks, and updater artifact
signing as a local release, then uploads its artifacts to the workflow. A final publish
job downloads both sets, writes the combined `latest.json`, and fills the release-please
draft release: it keeps the changelog body, appends the Mac download chooser that maps
Apple Silicon to `Reflect_aarch64.dmg` and Intel to `Reflect_x86_64.dmg` (with
`Reflect.Beta` names for beta releases), and undrafts the release as its last step. The
downstream beta-sync job then downloads the canonical DMGs and manifest from that
tagged release before refreshing `updater-beta`. The workflow normally runs via
`workflow_call` from
`.github/workflows/release-please.yml` when a Release PR merges. The manual fallback is
**Actions → Release → Run workflow** (tick *draft* to review the release before
publishing) on a branch whose `apps/desktop/package.json` version was already bumped by
a merged PR; in that mode publish creates the release (and its tag) itself, with
GitHub-generated notes.

The script reads all signing material from environment variables, which take
precedence over the keychain (exporting them works for local releases too); the
workflow wires them from repository Actions secrets of the same names. Create these
under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full identity string, e.g. `Developer ID Application: … (TEAMID)` — from `security find-identity -v -p codesigning` |
| `APPLE_CERTIFICATE` | The Developer ID certificate + private key: export a `.p12` from Keychain Access, then `base64 -i certificate.p12`. Tauri imports it for the `.app`; the release helper imports it again into a temporary keychain for DMG signing |
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
- **Bundled `reflect` or `reflect-capture-host` exits `Killed: 9`** — check its
  entitlements with `codesign -d --entitlements :- Reflect.app/Contents/MacOS/reflect`.
  Sidecars must not carry the app's restricted iCloud entitlements; the release verifier
  launches both sidecars to catch this.
- **Intel sidecar launch fails on Apple Silicon with `Bad CPU type in executable`** —
  install Rosetta (`softwareupdate --install-rosetta`) or verify the Intel target on an
  Intel runner.
- **`rejected, source=Unnotarized Developer ID`** — signing worked but the artifact has no
  notarization ticket; rerun without `--no-notarize`.
- **Notarization hangs** — Apple's service occasionally queues submissions for a long
  time; check status with `xcrun notarytool history --apple-id <id> --team-id <team>`.

## Current limitations

- iOS/TestFlight distribution is handled separately by `pnpm release:ios`; see
  [iOS TestFlight Builds](ios-testflight.md).
