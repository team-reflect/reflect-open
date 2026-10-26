# Running the iOS simulator

```bash
pnpm tauri:ios:dev "iPhone 17 Pro"   # `--host` for a physical device
xcrun simctl list devices available
```

Debug builds are the dev flavor (`app.reflect.ios.dev`, "Reflect Dev"). It needs the script's
`tauri.ios.dev.conf.json`: plain `tauri ios dev` writes the `app.reflect.ios` identifier from
`tauri.ios.conf.json` into the Xcode project instead.

With "Connect Hardware Keyboard" on (I/O → Keyboard, ⇧⌘K), the simulator shows no software
keyboard and `--keyboard-height` stays 0. Turn it off to test keyboard avoidance.

`tauri ios dev` rewrites files under `apps/desktop/src-tauri/gen/apple/` (`project.pbxproj`
build settings, the merged `Info.plist`). Do not commit those changes. To change the project,
edit `ios.project.yml` and `gen/apple/project.yml` and follow their header comment.
