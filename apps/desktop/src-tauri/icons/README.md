# App icons

One icon in three colors, one per build flavor. iOS and macOS show the same artwork.

| Dir           | Flavor      | productName  | Icon Composer document | Color         |
| ------------- | ----------- | ------------ | ---------------------- | ------------- |
| `icons/`      | stable      | Reflect      | `AppIcon.icon`         | blue/violet   |
| `icons-beta/` | beta        | Reflect Beta | `AppIcon-Beta.icon`    | purple/violet |
| `icons-dev/`  | dev (local) | Reflect Dev  | `AppIcon-Dev.icon`     | green         |

`icons/` is the default set: the base `tauri.conf.json` points `bundle.icon` here.
The `tauri.beta.conf.json` and `tauri.dev.conf.json` overlays point it at the
sibling dirs. All files in a dir come from the same artwork, so replace them as a set.

## Files

| File                                         | Used by                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| `*.icon`                                     | iOS (all versions) and the source of `Assets.car`          |
| `Assets.car`                                 | macOS (`CFBundleIconName`)                                 |
| `icon.icns`                                  | macOS fallback (`CFBundleIconFile`)                        |
| `icon.ico`                                   | Windows                                                    |
| `32x32.png`, `128x128.png`, `128x128@2x.png` | Linux, and the window icon that Tauri embeds in the binary |

- **iOS** compiles `icons/AppIcon.icon` (release: TestFlight and App Store) and
  `icons-dev/AppIcon-Dev.icon` (debug: `tauri ios dev`) straight from the Xcode
  project; `ASSETCATALOG_COMPILER_APPICON_NAME` picks one. Xcode also generates
  the flat icons for older iOS versions. Do not run `tauri icon`: it writes an
  `AppIcon.appiconset` and other files that nothing uses.
- **macOS** reads `Assets.car` from `bundle.icon`. After editing a `.icon`, rebuild
  the three `Assets.car` files with `pnpm --filter @reflect/desktop gen:icons`
  (Xcode 26+). The `.car` files are committed because Tauri's Node CLI cannot
  compile a `.icon` itself ([tauri-apps/tauri#15315](https://github.com/tauri-apps/tauri/issues/15315)).

## Dark, Clear, and Tinted appearances

iOS 26+ and macOS 26+ show app icons in Default, Dark, Clear, and Tinted
appearances. Each `.icon` has six layers in three groups: `nodes`, `edges`, and
`body` (the gem); `ring` and `glow` (the halo); and `background`.

- **Default** shows every layer.
- **Dark** hides `background`, so the gem glows on the system's dark background.
- **Clear and Tinted** also hide `background`. The system turns the remaining
  layers into a single glass or tinted image. `body` drops to 50% opacity and
  `glow` to 25%, so the gem's lines stay readable.

Icon Composer uses one appearance key, `tinted`, for both Clear and Tinted.

Preview any appearance without a simulator:

```bash
"$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool" \
  AppIcon.icon --export-image --output-file out.png --platform macOS \
  --rendition TintedDark --width 512 --height 512 --scale 1
```
