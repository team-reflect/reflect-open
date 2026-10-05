# Windows Builds (Experimental)

Reflect ships experimental Windows builds for x64 and arm64. They are **not
code-signed**.

## Getting the installer

Every release lists two NSIS installers on its GitHub release page:

- `*_x64-setup.exe` for Intel and AMD machines.
- `*_arm64-setup.exe` for Windows on Arm machines (for example, Snapdragon).

A Windows build failure does not block a release, so a release can lack one or
both installers.

To test a build that is not a release, use GitHub Actions:

1. Open the repo's **Actions** tab and select the **Windows** workflow.
2. Open the newest successful run (anyone with write access can also start one
   with **Run workflow**).
3. Download the `reflect-windows-x64` or `reflect-windows-arm64` artifact and
   unzip it. It contains the NSIS installer (`*-setup.exe`).

Artifacts expire after 90 days.

## What to expect

- **Supported OS:** Windows 10 22H2 (x64) or Windows 11 (x64 or arm64). The
  app is a Tauri 2 shell over WebView2; Windows 11 ships the runtime, and the
  installer downloads it on the few Windows 10 machines that lack it.
- **SmartScreen will warn.** The build is not code-signed yet, so the first
  launch shows "Windows protected your PC" — click **More info → Run
  anyway**. Microsoft Defender may also flag unsigned Rust binaries
  (a known false-positive pattern); machines with Smart App Control enabled
  cannot run unsigned apps at all.
- **Per-user install, no admin prompt.** The installer uses NSIS in
  `currentUser` mode and installs under `%LOCALAPPDATA%`.
- **Auto-update.** CI signs each installer with the updater key (minisign,
  the same key as macOS) and `latest.json` lists it as `windows-x86_64` or
  `windows-aarch64`. The app verifies that signature before it installs an
  update. This is separate from code signing.
- **No MSI.** Reflect's beta versions carry a prerelease suffix, which the
  MSI toolchain rejects; only the NSIS installer is produced.

## Roadmap

1. CI builds without code signing, listed on GitHub releases, with updater
   support (this document).
2. Free code signing (e.g. SignPath Foundation for open source), which
   removes the SmartScreen friction.
