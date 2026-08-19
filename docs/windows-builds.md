# Windows Builds (Experimental)

Reflect ships an experimental, **unsigned** Windows x64 build. It is not
listed on any GitHub release: the only way to get it is from GitHub Actions.

## Getting the installer

1. Open the repo's **Actions** tab and select the **Windows** workflow.
2. Open the newest successful run (releases trigger one automatically; anyone
   with write access can also start one with **Run workflow**).
3. Download the `reflect-windows-x64` artifact and unzip it. It contains the
   NSIS installer (`*-setup.exe`) plus a `windows-x64.json` metadata file.

Artifacts expire after 90 days.

## What to expect

- **Supported OS:** Windows 10 22H2 or Windows 11, x64. The app is a Tauri 2
  shell over WebView2; Windows 11 ships the runtime, and the installer
  downloads it on the few Windows 10 machines that lack it.
- **SmartScreen will warn.** The build is not code-signed yet, so the first
  launch shows "Windows protected your PC" — click **More info → Run
  anyway**. Microsoft Defender may also flag unsigned Rust binaries
  (a known false-positive pattern); machines with Smart App Control enabled
  cannot run unsigned apps at all.
- **Per-user install, no admin prompt.** The installer uses NSIS in
  `currentUser` mode and installs under `%LOCALAPPDATA%`.
- **No auto-update.** The updater feed carries no Windows entries yet, so the
  built-in updater finds nothing; install newer builds manually.
- **No MSI.** Reflect's beta versions carry a prerelease suffix, which the
  MSI toolchain rejects; only the NSIS installer is produced.

## Roadmap

1. Unsigned CI builds (this document).
2. Free code signing (e.g. SignPath Foundation for open source), which
   removes the SmartScreen friction. Applying requires existing CI-built
   artifacts, which is why signing lands second.
3. Only after real testing: updater support and listing on GitHub releases.
