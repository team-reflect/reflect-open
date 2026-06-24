# App icons

Three color sets, one per build flavor. Same gradient gem artwork, different hue.

| Dir           | Color        | Flavor        | productName  | modulate (B,S,H) |
| ------------- | ------------ | ------------- | ------------ | ---------------- |
| `icons/`      | blue/violet  | stable        | Reflect      | none (as shipped) |
| `icons-beta/` | magenta/pink | beta (`next`) | Reflect Beta | `104,100,151`    |
| `icons-dev/`  | green        | dev (local)   | Reflect Dev  | `92,100,231`     |

`icons/` is the shipped app icon and the default set Tauri uses with no `--config`;
the base `tauri.conf.json` points its `bundle.icon` here. The `tauri.beta.conf.json`
and `tauri.dev.conf.json` overlays repoint `bundle.icon` at the sibling dirs.

The beta/dev sets are the stable artwork run through `magick -modulate B,S,H`
(B=lightness, S=saturation, 100=unchanged). The iOS asset catalog
(`../gen/apple/Assets.xcassets/AppIcon.appiconset/`) uses the stable artwork; iOS is
not flavored.

## Regenerating a flavor set

ImageMagick on macOS has no ICNS writer, so recolor the rasters in place and rebuild
`icon.icns` from a recolored master with the native tools:

```bash
mod="104,100,151"           # the flavor's modulate (see table)
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

The hues were chosen from the 400-variant contact sheet: beta = id 387 (hue ≈ 342°),
dev = id 149 (hue ≈ 126°). Eyeball any new pick.
