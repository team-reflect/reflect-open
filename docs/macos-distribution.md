# macOS Distribution Builds

```bash
pnpm build:macos                                  # signed + notarized build for this Mac
pnpm build:macos --target=universal-apple-darwin  # one app for Apple Silicon and Intel
pnpm build:macos --no-notarize                    # signed only; Gatekeeper rejects it elsewhere
```

`apps/desktop/scripts/build-macos.ts` only builds. Uploading and publishing happen in
`.github/workflows/publish-macos.yml` and `publish-desktop.yml`. Contributors without the
certificate can still build unsigned bundles with `pnpm tauri build`.

## What you need

1. **A Developer ID Application certificate** in your login keychain. "Apple Distribution"
   is App Store only. Only the Apple Developer **Account Holder** can create one, at
   [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates).
   Export the identity string from `security find-identity -v -p codesigning` as
   `APPLE_SIGNING_IDENTITY`.
2. **Notarization credentials**: an App Store Connect API key (`APPLE_API_KEY`,
   `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` or `APPLE_API_KEY_CONTENT`), or, for local builds
   only, an Apple ID with an app-specific password (`APPLE_ID`, `APPLE_PASSWORD`) created at
   [account.apple.com](https://account.apple.com) → Sign-In and Security.
3. **Xcode Command Line Tools** (`xcode-select --install`).
4. **The updater private key** as `TAURI_SIGNING_PRIVATE_KEY`. Without it, a local build skips
   the updater archive. **Losing it strands every installed app**, because they reject updates
   not signed with it. To rotate it, generate a pair with `pnpm tauri signer generate` and ship
   the new pubkey in a release signed with the old key.
5. **Sentry credentials**: `VITE_SENTRY_DSN` and `SENTRY_AUTH_TOKEN`. Never give the token a
   `VITE_` prefix: it must not enter the app bundle.

### CI secrets

CI reads the same variables from the `release_app` environment (**Settings → Environments**),
which only `master` can use. Values that need preparation:

| Secret | How to make it |
| --- | --- |
| `APPLE_CERTIFICATE` | Export the certificate and private key as `.p12` from Keychain Access, then `base64 -i certificate.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password set on that export |
| `APPLE_API_KEY_CONTENT` | The `.p8` file contents, raw or base64 |
| `SENTRY_DSN` | The public DSN of the production Sentry project |

The updater key has no password. No PAT is needed: releases use `GITHUB_TOKEN`.

## Cutting a release

release-please keeps two Release PRs open on `master`: beta (`chore: release X.Y.Z-beta.N`)
and stable (`chore: release X.Y.Z`). **Merging a Release PR is the release.** The Release
workflow then builds every platform into a draft GitHub release and publishes it only after
the macOS, Windows, and Linux builds succeed. TestFlight runs in the same workflow.

- Release PRs are created with `GITHUB_TOKEN`, so their checks do not start by themselves.
  Use the run-checks button before you merge one.
- To polish the changelog, edit the PR branch last: release-please regenerates the PR when new
  commits land.
- A stable release builds `master` as of its merge, which can include commits no beta shipped.
  To ship a beta-tested snapshot, merge the stable Release PR right after a healthy beta.
- Merging the stable Release PR makes the open beta Release PR conflict. Leave it: the next
  releasable commit rewrites it.
- A hotfix is a normal `fix:` PR followed by the stable Release PR.
- Never hand-edit the version, changelogs, or manifests, and never use `Release-As:` footers.
  A major graduation such as `1.0.0` is a one-time `release-as` in both configs.

**Retrying:** re-run the failed jobs of the Release run. There is no manual entry point. A
re-run uses the original workflow files and is allowed for 30 days.

## Build flavors

| Flavor | Version | Identifier | Updater feed |
| --- | --- | --- | --- |
| Reflect | `X.Y.Z` | `app.reflect.desktop` | `releases/latest` |
| Reflect Beta | `X.Y.Z-beta.N` | `app.reflect.desktop.beta` | `updater-beta` release |
| Reflect Dev | local builds | `app.reflect.desktop.dev` | none (`updater-dev-noop`) |

The version string alone picks the flavor, so a release always matches its feed. Settings,
recent graphs, and keychain secrets are **shared** across flavors; webview storage and the
embeddings cache are not.

GitHub rewrites spaces in asset names to dots, so beta assets are named `Reflect.Beta`. Do not
"fix" the dot, or beta auto-update 404s.

The DMG names are fixed (`Reflect_aarch64.dmg`, `Reflect_universal.dmg`) so the README's
download links never change. Updater archives stay versioned.

## Symbolicating a crash

Each release attaches dSYMs as `*.dSYMs.zip`.

1. Get the report: `~/Library/Logs/DiagnosticReports/reflect-open-*.ips`, or Console → Crash
   Reports. Under `usedImages`, note the `uuid`, `arch`, and `base` of `reflect-open`. A frame's
   address is `base` plus its `imageOffset`.
2. Download and unzip the dSYMs:

   ```bash
   gh release download v<version> --repo team-reflect/reflect-open --pattern '*.dSYMs.zip'
   ```

3. Pick the dSYM whose `dwarfdump --uuid <triple>/reflect-open.dSYM` matches the report, then:

   ```bash
   atos -o <triple>/reflect-open.dSYM/Contents/Resources/DWARF/reflect-open -arch <arch> -l <base> <address>...
   ```

   Pipe the output through `rustfilt` (`cargo install rustfilt`) to demangle Rust names.

## Troubleshooting

- **`codesign` cannot find the identity**: the certificate is not in your *login* keychain, or
  it is the wrong type. An incomplete certificate does not appear in `security find-identity`.
- **Notarization `status: Invalid`**: read the notary log the script prints. A common cause is
  a binary without hardened runtime.
- **Bundled `reflect` or `reflect-capture-host` exits `Killed: 9`**: a sidecar carries the app's
  restricted iCloud entitlements. Check with
  `codesign -d --entitlements :- Reflect.app/Contents/MacOS/reflect`.
- **`Bad CPU type in executable`** when an Intel or universal build launches its sidecars on
  Apple Silicon: install Rosetta (`softwareupdate --install-rosetta`).
- **`rejected, source=Unnotarized Developer ID`**: the build ran with `--no-notarize`.
- **Notarization hangs**: Apple sometimes queues submissions. Check
  `xcrun notarytool history`.

iOS has its own guide: [iOS TestFlight Builds](ios-testflight.md).
