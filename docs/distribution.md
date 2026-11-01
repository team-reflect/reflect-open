# Distribution

How Reflect ships: macOS (signed and notarized), iOS (TestFlight), Windows, and Linux. The steps
live in `apps/desktop/scripts/` and the `publish-*.yml` workflows. This file holds what they
cannot say.

## Cutting a release

release-please keeps two Release PRs open on `master`, beta and stable. **Merging a Release PR
is the release.** The Release workflow builds every platform into a draft GitHub release and
uploads to TestFlight. The release publishes only after the macOS, Windows, and Linux builds
all succeed.

- Release PRs are created with `GITHUB_TOKEN`, so their checks do not start by themselves. Use
  the run-checks button before you merge.
- Edit the changelog last: release-please regenerates the PR when new commits land.
- A stable release builds `master` as of its merge, which can include commits no beta shipped.
  To ship a beta-tested snapshot, merge the stable PR right after a healthy beta.
- After a stable merge, the open beta PR conflicts. Leave it: the next releasable commit
  rewrites it.
- A hotfix is a normal `fix:` PR, then the stable Release PR.
- Never hand-edit versions, changelogs, or manifests, and never use `Release-As:` footers. A
  major graduation such as `1.0.0` is a one-time `release-as` in both configs.
- **Retrying:** re-run the failed jobs of the Release run (allowed for 30 days). There is no
  manual entry point.

## Credentials

CI reads every credential from the `release_app` environment, which only `master` can use. Local
builds read the same names from environment variables. No PAT is needed.

| Secret | How to make it |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | A **Developer ID Application** certificate (not "Apple Distribution"). Only the Account Holder can create one. Copy the string from `security find-identity -v -p codesigning`. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | Export the certificate and its key as `.p12` from Keychain Access, then `base64 -i certificate.p12`. The password is the export password. |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_CONTENT` | An App Store Connect API key. The content is the `.p8` file, raw or base64. |
| `TAURI_SIGNING_PRIVATE_KEY` | The updater key (no password). **Losing it strands every installed app.** To rotate, generate a pair with `pnpm tauri signer generate` and ship the new pubkey in a release signed with the old key. |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | The production Sentry project. Local builds read the DSN as `VITE_SENTRY_DSN`, and iOS also as `REFLECT_SENTRY_DSN`. Never give the token a `VITE_` prefix: it must not enter an app bundle. |

## macOS

### Build

```bash
pnpm build:macos [--target=universal-apple-darwin] [--no-notarize]
```

Gatekeeper rejects a `--no-notarize` build on other Macs.

### Install

Each release attaches `Reflect_aarch64.dmg` and `Reflect_universal.dmg`. Beta uses
`Reflect.Beta_*` and a separate updater feed.

- DMG names carry no version, so the README's download links never change.
- GitHub turns spaces in asset names into dots. Do not "fix" `Reflect.Beta`, or beta
  auto-update 404s.
- Reflect and Reflect Beta are separate apps, but they **share** settings, recent graphs, and
  keychain secrets.

### Requirements

Apple Silicon, or Intel with the universal build.

### Troubleshooting

- **`codesign` cannot find the identity**: the certificate is not in your *login* keychain, or
  it is the wrong type.
- **Notarization `status: Invalid`**: read the notary log the script prints (often a binary
  without hardened runtime). If it hangs, check `xcrun notarytool history`.
- **A sidecar exits `Killed: 9`**: it carries the app's restricted iCloud entitlements.
- **`Bad CPU type in executable`** on Apple Silicon: install Rosetta
  (`softwareupdate --install-rosetta`).
- **A crash report is unsymbolicated**: download and unzip the release's `*.dSYMs.zip`, and pick
  the dSYM whose `dwarfdump --uuid` matches the report. Take `base` and
  `arch` of `reflect-open` from `usedImages` in the `.ips` file. A frame address is `base` plus
  its `imageOffset`:

  ```bash
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
upload to the same marketing version, without the `-beta.N` suffix.

### Requirements

iPhone or iPad. The minimum iOS version is `deploymentTarget` in
`apps/desktop/src-tauri/ios.project.yml`.

### Troubleshooting

- **`Automatic signing cannot register bundle identifier "app.reflect.ios.<ext>"`**: a new app
  extension ships for the first time, and the CI key cannot register identifiers. Build it once
  from a Mac signed into the team, then rerun:

  ```bash
  cd apps/desktop/src-tauri/gen/apple
  xcodebuild -project reflect-open.xcodeproj -target <NewExtension> \
    -sdk iphoneos -configuration release -allowProvisioningUpdates build
  ```

- **`Cannot determine the Apple ID from Bundle ID 'app.reflect.ios'`**: create the App Store
  Connect app record. Do not reuse the old Capacitor app (`app.reflect.ReflectMobile`).
- **Duplicate build number, or an older build shows as latest**: build numbers must be unique,
  and should increase, within one marketing version.
- **A TestFlight feedback ZIP has no stack**: expected. Read Sentry, or ask for the `.ips`
  report.
- **A crash report is unsymbolicated**: the dSYM is in the build's
  `reflect-ios-xcarchive-<build>` workflow artifact, not in the IPA.

## Windows

### Build

```bash
pnpm build:windows [--target=aarch64-pc-windows-msvc]
```

### Install

Each release attaches `*_x64-setup.exe` and `*_arm64-setup.exe`, not code-signed. The installer
is per-user and needs no admin.

- On first launch, "Windows protected your PC" appears: click **More info → Run anyway**.
- Auto-update still works: it checks the updater key, not code signing.
- There is no MSI: the MSI toolchain rejects prerelease versions such as `-beta.N`.

### Requirements

Windows 10 22H2 (x64) or Windows 11 (x64, arm64).

### Troubleshooting

- **The app does not start**: Smart App Control is on and blocks unsigned apps. Defender can
  also flag unsigned Rust binaries.

## Linux

### Build

```bash
pnpm build:linux [--target=aarch64-unknown-linux-gnu]
```

### Install

Each release attaches an AppImage and a `.deb` for x64 and arm64, not code-signed.

- **AppImage** needs no install and bundles WebKitGTK. Make it executable and keep it in a
  writable folder: updates replace the file.
- **`.deb`** (`sudo apt install ./<file>.deb`) uses the system WebKitGTK, adds a menu entry,
  registers `reflect://`, and updates through `pkexec`.
- Not supported yet: browser capture, audio memos, iCloud, Calendar, and Contacts.

### Requirements

- glibc 2.39+ (Ubuntu 24.04+, Debian 13+, Fedora 40+). The prebuilt ONNX Runtime needs glibc
  2.38 and GCC 14's libstdc++.
- On x64, an AVX2 CPU for semantic search.
- A Secret Service keyring (GNOME Keyring or KWallet) to save secrets.

### Troubleshooting

- **Crash when semantic search starts (x64)**: the CPU has no AVX2.
- **Secrets are not saved**: no keyring is running.
- **Blank or flickering window** (often NVIDIA): start with `WEBKIT_DISABLE_DMABUF_RENDERER=1`,
  then also `WEBKIT_DISABLE_COMPOSITING_MODE=1`.
