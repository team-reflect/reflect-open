# Original purple app icons

The original (V1-style purple) app icon set, preserved when the default switched
to the crimson variant. The active set in `../icons/` and the iOS asset catalog at
`../gen/apple/Assets.xcassets/AppIcon.appiconset/` are the same artwork with a
+92° hue rotation applied (`magick <file> -modulate 100,100,151 <file>`).

## Swapping back to purple

From `apps/desktop/src-tauri/`:

```bash
rsync -a --exclude ios-appiconset --exclude README.md icons-purple/ icons/
cp icons-purple/ios-appiconset/*.png gen/apple/Assets.xcassets/AppIcon.appiconset/
```

`ios-appiconset/` holds the purple PNGs for the iOS asset catalog; everything else
mirrors the layout of `icons/` (desktop sizes, `icon.icns`, `icon.ico`, Windows
Store logos, and Android mipmaps).
