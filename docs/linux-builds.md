# Linux Builds (Experimental)

Reflect ships experimental Linux builds for x64 and arm64. They are **not
code-signed**.

## Getting the packages

When the Linux builds succeed, a release lists four packages on its GitHub
release page:

- `*_amd64.AppImage` and `*_amd64.deb` for Intel and AMD machines.
- `*_aarch64.AppImage` and `*_arm64.deb` for Arm machines.

Choose one format:

- **AppImage:** one file that runs without installation and without root.
  Make it executable (`chmod +x`) and run it. It carries its own GTK and
  WebKitGTK, so it works on most distributions. It does not add itself to the
  application menu.
- **`.deb`:** for Debian, Ubuntu, Linux Mint, and other Debian-based
  distributions. Install it with `sudo apt install ./<file>.deb`. It uses the
  system WebKitGTK, adds an application menu entry, and registers the
  `reflect://` scheme.

A Linux build failure does not block a release, so a release can lack some or
all Linux packages.

To test a build that is not a release, use GitHub Actions:

1. Open the repo's **Actions** tab and select the **Publish Linux** workflow.
2. Open the newest successful run (anyone with write access can also start one
   with **Run workflow**).
3. Download the `reflect-linux-x64` or `reflect-linux-arm64` artifact and
   unzip it. It contains the AppImage and the `.deb`.

Artifacts expire after 30 days.

## What to expect

- **Supported systems:** glibc 2.39 or newer, for example Ubuntu 24.04+,
  Linux Mint 22+, Debian 13+, and Fedora 40+. CI builds on Ubuntu 24.04,
  because a binary needs the glibc of its build machine or newer. Older
  releases such as Ubuntu 22.04 and Debian 12 are not supported: the prebuilt
  ONNX Runtime used by semantic search needs glibc 2.38 and the libstdc++ of
  GCC 14. The app is a Tauri 2 shell over WebKitGTK 4.1.
- **Semantic search on x64 needs AVX2.** The prebuilt ONNX Runtime requires
  an x86-64-v3 CPU (most Intel and AMD CPUs since 2013-2015; some Atom,
  Celeron, and Pentium models lack it). On a CPU without AVX2, the app can
  crash when semantic search starts. arm64 has no such requirement.
- **Secrets need a keyring.** AI provider keys and the GitHub token are kept in
  the Secret Service (GNOME Keyring or KWallet). Without one, the app cannot
  save them.
- **Auto-update.** CI signs each package with the updater key (minisign, the
  same key as macOS and Windows). `latest.json` lists the AppImages as
  `linux-x86_64-appimage` and `linux-aarch64-appimage`, and the `.deb` packages as
  `linux-x86_64-deb` and `linux-aarch64-deb`. An AppImage replaces itself, so
  it must be in a folder you can write to. A `.deb` update asks for your
  password through `pkexec`.
- **Not supported yet:** browser capture (the extension cannot find the native
  host), audio memo recording, iCloud, and the Calendar and Contacts
  integrations.
- **Blank or flickering window:** some GPU drivers (often NVIDIA) do not work
  with WebKitGTK's DMA-BUF renderer. Start the app with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, and if that does not help, also with
  `WEBKIT_DISABLE_COMPOSITING_MODE=1`.

## Roadmap

1. CI builds without code signing, listed on GitHub releases, with updater
   support (this document).
2. Browser capture: native messaging manifests for Chromium-based browsers,
   and stable sidecar paths for the AppImage.
3. Audio memo recording on WebKitGTK.
