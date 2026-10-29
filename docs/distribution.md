# Distribution

How Reflect ships: macOS (signed and notarized), iOS (TestFlight), and experimental Windows and
Linux builds. The scripts in `apps/desktop/scripts/` and the `publish-*.yml` workflows are the
source of truth for the steps. This file holds what they cannot say.

## Cutting a release

release-please keeps two Release PRs open on `master`: beta (`chore: release X.Y.Z-beta.N`) and
stable (`chore: release X.Y.Z`). **Merging a Release PR is the release.** The Release workflow
builds every platform into a draft GitHub release, uploads to TestFlight, and publishes the
release after the macOS, Windows, and Linux builds succeed.

- Release PRs are created with `GITHUB_TOKEN`, so their checks do not start by themselves. Use
  the run-checks button before you merge one.
- To polish the changelog, edit the PR branch last: release-please regenerates the PR when new
  commits land.
- A stable release builds `master` as of its merge, which can include commits no beta shipped.
  To ship a beta-tested snapshot, merge the stable Release PR right after a healthy beta.
- Merging the stable Release PR makes the open beta Release PR conflict. Leave it: the next
  releasable commit rewrites it.
- A hotfix is a normal `fix:` PR followed by the stable Release PR.
- Never hand-edit the version, changelogs, or manifests, and never use `Release-As:` footers. A
  major graduation such as `1.0.0` is a one-time `release-as` in both configs.
- **Retrying:** re-run the failed jobs of the Release run. There is no manual entry point. A
  re-run uses the original workflow files and is allowed for 30 days.

## Credentials

CI reads every credential from the `release_app` environment (**Settings → Environments**),
which only `master` can use. Local builds read the same names from environment variables. The
workflows check that each one is set before they build.

| Secret | How to make it |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | A **Developer ID Application** certificate ("Apple Distribution" is App Store only). Only the Account Holder can create one, at [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates). Copy the string from `security find-identity -v -p codesigning`. |
| `APPLE_CERTIFICATE` | Export that certificate and its private key as `.p12` from Keychain Access, then `base64 -i certificate.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | The password set on that export. |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_CONTENT` | An App Store Connect API key. `APPLE_API_KEY_CONTENT` is the `.p8` file, raw or base64. Locally, `APPLE_API_KEY_PATH` can replace it, or an Apple ID with an app-specific password (`APPLE_ID`, `APPLE_PASSWORD`) can notarize. |
| `TAURI_SIGNING_PRIVATE_KEY` | The updater key (no password). **Losing it strands every installed app.** To rotate it, generate a pair with `pnpm tauri signer generate` and ship the new pubkey in a release signed with the old key. |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | The production Sentry project. Never give the token a `VITE_` prefix: it must not enter an app bundle. |

No PAT is needed: releases use `GITHUB_TOKEN`. Without the certificate, `pnpm tauri build` still
makes an unsigned bundle.

## macOS

### Build

```bash
pnpm build:macos [--target=universal-apple-darwin] [--no-notarize]
```

`--no-notarize` makes a signed build that Gatekeeper rejects on other Macs.

### Install

Each release attaches `Reflect_aarch64.dmg` (Apple Silicon) and `Reflect_universal.dmg` (Apple
Silicon and Intel), signed and notarized. Beta releases use `Reflect.Beta_*` and a separate
updater feed.

- DMG names carry no version, so the README's download links never change.
- GitHub rewrites spaces in asset names to dots. Do not "fix" `Reflect.Beta`, or beta
  auto-update 404s.
- Reflect and Reflect Beta are separate apps, but they **share** settings, recent graphs, and
  keychain secrets.

### Requirements

Apple Silicon, or Intel with the universal build.

### Troubleshooting

- **`codesign` cannot find the identity**: the certificate is not in your *login* keychain, or
  it is the wrong type.
- **Notarization `status: Invalid`**: read the notary log the script prints. A common cause is a
  binary without hardened runtime.
- **Notarization hangs**: Apple sometimes queues submissions. Check `xcrun notarytool history`.
- **A sidecar exits `Killed: 9`**: it carries the app's restricted iCloud entitlements.
- **`Bad CPU type in executable`** when an Intel or universal build launches its sidecars on
  Apple Silicon: install Rosetta (`softwareupdate --install-rosetta`).
- **A crash report is unsymbolicated**: each release attaches `*.dSYMs.zip`. In the `.ips`
  report, note the `uuid`, `arch`, and `base` of `reflect-open` under `usedImages`. A frame's
  address is `base` plus its `imageOffset`.

  ```bash
  gh release download v<version> --repo team-reflect/reflect-open --pattern '*.dSYMs.zip'
  dwarfdump --uuid <triple>/reflect-open.dSYM   # pick the dSYM whose UUID matches
  atos -o <triple>/reflect-open.dSYM/Contents/Resources/DWARF/reflect-open -arch <arch> -l <base> <address>... | rustfilt
  ```

## iOS

### Build

```bash
pnpm build:ios --build-number=<number>
pnpm upload:testflight
```

### Install

Testers join the [TestFlight beta](https://testflight.apple.com/join/j2eEz43d). Beta and stable
releases upload to the same marketing version, without the `-beta.N` suffix.

### Requirements

iPhone or iPad. The minimum iOS version is `deploymentTarget` in
`apps/desktop/src-tauri/ios.project.yml`.

### Troubleshooting

- **`Automatic signing cannot register bundle identifier "app.reflect.ios.<ext>"`**: a new app
  extension ships for the first time, and the CI key cannot register identifiers. Register it
  once from a Mac signed into the team, then rerun:

  ```bash
  cd apps/desktop/src-tauri/gen/apple
  xcodebuild -project reflect-open.xcodeproj -target <NewExtension> \
    -sdk iphoneos -configuration release -allowProvisioningUpdates build
  ```

- **`Cannot determine the Apple ID from Bundle ID 'app.reflect.ios'`**: create the App Store
  Connect app record. Do not reuse the old Capacitor app (`app.reflect.ReflectMobile`).
- **Duplicate build number, or TestFlight shows an older build as latest**: build numbers must be
  unique, and should increase, within one marketing version.
- **A TestFlight feedback ZIP has no stack**: expected. Read the native events in Sentry, or ask
  for the Apple `.ips` report.
- **A crash report is unsymbolicated**: use the dSYM in the `reflect-ios-xcarchive-<build>`
  workflow artifact of that build. The IPA has no dSYM.

## Windows (experimental)

### Build

```bash
pnpm build:windows [--target=aarch64-pc-windows-msvc]
```

### Install

Each release can attach `*_x64-setup.exe` and `*_arm64-setup.exe`, not code-signed. A Windows
build failure does not block a release.

- The installer is per-user and needs no admin.
- The first launch shows "Windows protected your PC": click **More info → Run anyway**.
  Defender can flag unsigned Rust binaries, and Smart App Control blocks them.
- Auto-update still works: it checks the updater key, not code signing.
- There is no MSI: the MSI toolchain rejects prerelease versions such as `-beta.N`.

### Requirements

Windows 10 22H2 (x64) or Windows 11 (x64, arm64).

### Troubleshooting

- **The app does not start after install**: Smart App Control is on, and it blocks unsigned
  apps.

## Linux (experimental)

### Build

```bash
pnpm build:linux [--target=aarch64-unknown-linux-gnu]
```

### Install

Each release can attach an AppImage and a `.deb` for x64 and arm64, not code-signed. A Linux
build failure does not block a release.

- **AppImage** runs without installation and carries its own WebKitGTK. Make it executable and
  keep it in a writable folder, because updates replace the file.
- **`.deb`** (`sudo apt install ./<file>.deb`) uses the system WebKitGTK, adds a menu entry,
  registers `reflect://`, and asks for a password (`pkexec`) to update.
- Not supported yet: browser capture, audio memo recording, iCloud, Calendar, and Contacts.

### Requirements

- glibc 2.39 or newer (Ubuntu 24.04+, Debian 13+, Fedora 40+). The prebuilt ONNX Runtime for
  semantic search needs glibc 2.38 and GCC 14's libstdc++.
- On x64, an AVX2 CPU for semantic search.
- A Secret Service keyring (GNOME Keyring or KWallet) to save secrets.

### Troubleshooting

- **Crash when semantic search starts (x64)**: the CPU has no AVX2.
- **Secrets are not saved**: no keyring is running.
- **Blank or flickering window** (often NVIDIA): start with `WEBKIT_DISABLE_DMABUF_RENDERER=1`,
  then also `WEBKIT_DISABLE_COMPOSITING_MODE=1`.
