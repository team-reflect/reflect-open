# App icons

Three color sets, one per build flavor. Same gradient gem artwork, different hue.

| Dir           | Color        | Flavor        | productName  | modulate (B,S,H) |
| ------------- | ------------ | ------------- | ------------ | ---------------- |
| `icons/`      | blue/violet  | stable        | Reflect      | none (as shipped) |
| `icons-beta/` | purple/violet | beta          | Reflect Beta | `104,100,120`    |
| `icons-dev/`  | green        | dev (local)   | Reflect Dev  | `92,100,231`     |

`icons/` is the shipped app icon and the default set Tauri uses with no `--config`;
the base `tauri.conf.json` points its `bundle.icon` here. The `tauri.beta.conf.json`
and `tauri.dev.conf.json` overlays repoint `bundle.icon` at the sibling dirs.

The beta/dev sets are the stable artwork run through `magick -modulate B,S,H`
(B=lightness, S=saturation, 100=unchanged).

## Dark, Clear, and Tinted appearances

iOS 26+ and macOS 26+ render app icons in Default, Dark, Clear, and Tinted
appearances. Each dir holds an Icon Composer document for that flavor
(`AppIcon.icon`, `AppIcon-Beta.icon`, `AppIcon-Dev.icon`): a gradient fill plus
the gem as one transparent layer. The beta/dev documents are the stable one with
the gem layer and the gradient colors run through the flavor's modulate.

- **iOS** compiles `icons/AppIcon.icon` (release: TestFlight and App Store) and
  `icons-dev/AppIcon-Dev.icon` (debug: `tauri ios dev`) straight from the Xcode
  project; `ASSETCATALOG_COMPILER_APPICON_NAME` picks one. Xcode also generates
  the flat icons for iOS 16 to 18. Do not run `tauri icon` for iOS: it writes an
  `AppIcon.appiconset`, which the `.icon` would shadow.
- **macOS** reads `Assets.car` from `bundle.icon`. `icon.icns` stays as the
  fallback for macOS 15 and earlier. After editing a `.icon`, rebuild the three
  `Assets.car` files with `pnpm --filter @reflect/desktop gen:icons` (Xcode 26+).
  The script draws the layers 1024/824 times larger, because `icon.icns` crops
  the iOS art to its center 824 px.
  The `.car` files are committed because Tauri's Node CLI cannot compile a `.icon`
  itself ([tauri-apps/tauri#15315](https://github.com/tauri-apps/tauri/issues/15315)).

Preview any appearance without a simulator:

```bash
"$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool" \
  AppIcon.icon --export-image --output-file out.png --platform macOS \
  --rendition TintedDark --width 512 --height 512 --scale 1
```

## Regenerating a flavor set

ImageMagick on macOS has no ICNS writer, so recolor the rasters in place and rebuild
`icon.icns` from a recolored master with the native tools:

```bash
mod="104,100,120"           # the flavor's modulate (see table)
cp -R icons icons-<flavor>
find icons-<flavor> -type f \( -iname '*.png' -o -iname '*.ico' \) -print0 \
  | while IFS= read -r -d '' f; do magick "$f" -modulate "$mod" "$f"; done

sips -s format png icons/icon.icns --out /tmp/master.png   # the stable 1024 master
magick /tmp/master.png -modulate "$mod" /tmp/recolored.png
mkdir /tmp/set.iconset
for s in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" "128 128x128" \
         "256 128x128@2x" "256 256x256" "512 256x256@2x" "512 512x512"; do
  set -- $s; sips -z "$1" "$1" /tmp/recolored.png --out "/tmp/set.iconset/icon_$2.png"
done
cp /tmp/recolored.png /tmp/set.iconset/icon_512x512@2x.png
iconutil -c icns /tmp/set.iconset -o icons-<flavor>/icon.icns
```

Dev's hue came from the 400-variant contact sheet (id 149, hue ≈ 126°). Beta was
hand-tuned to a purple-violet (hue ≈ 286°) — distinct from the stable blue/violet but
no longer the near-red magenta of the original contact-sheet pick. Eyeball any new pick.
