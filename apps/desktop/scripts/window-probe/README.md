# Window probe (macOS 26 window-collapse investigation)

A user on macOS 26 ended up with `~/Library/Application Support/app.reflect.desktop.beta/.window-state.json` containing a 2x2-pixel main window, which makes Reflect restore an invisible window on every launch. The collapse itself has not been reproduced yet; this probe build collects, in one automated run on a macOS 26 machine, the data needed to reproduce it end to end and to decide whether the frame collapse comes from AppKit (Apple bug) or from the tao/tauri layer.

This branch is never merged. The probe app is a normal Reflect build plus:

- full window-geometry logging (`src-tauri/src/window_probe.rs`): every resize/move event and every geometry change is recorded twice, once as tao/tauri sees it and once as raw AppKit reports it (NSWindow frame, contentView frame, contentRect, styleMask, isZoomed, occlusion, screen frames), plus a dump at the exact exit moment where the window-state plugin reads what it persists;
- a scenario runner that replays updater-style relaunch cycles (zoom, un-zoom races, hide, minimize, fullscreen, tiling) driven by a plan file;
- its own identity (`Reflect Probe`, `app.reflect.desktop.probe`), so it never touches a real Reflect install, and no `minWidth`/`minHeight` on the window, so nothing masks the bug;
- a neutered updater endpoint, so the probe can never update itself away.

## Running the probe (on the macOS 26 test machine)

1. Download the `reflect-window-probe-macos-arm64` artifact from the "Window probe (macOS arm64)" GitHub Actions run and unzip it. It contains `Reflect-Probe.app.zip`, `run.sh`, and this README.
2. In Terminal, from the unzipped folder:

   ```bash
   chmod +x run.sh && ./run.sh Reflect-Probe.app.zip
   ```

3. When macOS asks for permission for Terminal to control **System Events**, click Allow. This lets the script drive real window tiling through the app's Window menu, which is the one suspect that cannot be triggered programmatically.
4. Leave the machine alone for about five minutes. The window opens, moves, tiles, and relaunches repeatedly; that is the test.
5. When the script prints `DONE`, send back the `reflect-window-probe-<timestamp>.zip` it created on the Desktop.

The zip contains the full event log (`probe.log`, one JSON object per line), every distinct version of `.window-state.json` the run produced (`state-history/`), the driver's own log, and machine info (`sw_vers`, display configuration, WindowManager tiling defaults).

Extra useful passes, if there is time:

- Run `./run.sh Reflect-Probe.app.zip` again with a different display setup (external monitor attached or detached, different scaling).
- Open `Reflect Probe.app` by hand and use it like the real app for a while (tile it, zoom it, quit from tiled/zoomed states, let it sit); all logging is always on. Then run `./run.sh --collect-only` to zip whatever was recorded.

## Reading the results

Search `probe.log` for `"tag":"anomaly:` lines: they mark any moment either layer reported a dimension under 300 physical pixels. Each carries the paired `tao` and `appkit` snapshots:

- `appkit.frame` / `appkit.contentViewFrame` collapsed too: AppKit itself set a degenerate frame (Apple bug; the record shows exactly which window-arrangement state, `styleMask`, `isZoomed`, and screen it happened under).
- `appkit` sane but `tao.innerSize` tiny: the collapse is in the tao/tauri layer.
- `state-file:changed` records show precisely which exit persisted a degenerate size.
