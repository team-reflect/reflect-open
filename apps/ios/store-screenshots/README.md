# App Store screenshots

```bash
pnpm store-screenshots
```

Writes the five screenshots of each App Store size to `screenshots/<device>/`, ready to upload. They are committed, so a run shows its changes in the diff.
It takes about 10 minutes, most of it in the simulator.

| Device | Simulator | Size (px) | App Store Connect |
| --- | --- | --- | --- |
| `iphone` | iPhone 18 Pro Max | 1320 × 2868 | iPhone 6.9" |
| `iphone-medium` | iPhone 18 Pro | 1206 × 2622 | iPhone 6.3" |
| `ipad` | iPad Pro 13-inch (M5) | 2064 × 2752 | iPad 13" |
| `ipad-11` | iPad Pro 11-inch (M5) | 1668 × 2420 | iPad 11" |

Options:

- `--device <name>`: only this device. Repeat it for more devices.
- `--skip-build`: use the app from the last build.
- `--skip-capture`: compose from the raw screens of the last run, after a change to the captions
  (`copy.ts`) or the layout (`compose.ts`).

## Steps

1. **Build** the web app, the Rust core, and the Debug-Dev app with its UI tests.
2. **Capture** (`capture.ts`): for each device, one simulator at a time, in light and dark:
   `StoreScreenshotsUITests` starts the app with the demo graph of `fixture.ts` and saves
   `out/raw/<device>/<theme>/<screen>.png`. The app reads the graph through `UITestFixture`
   (Debug builds only): notes, settings, the AI key, and the answer of the AI provider.
3. **Compose** (`compose.ts`): the caption of `copy.ts` above the raw screen in Apple's bezel.

Each device has its own simulator, `reflect-store-<device>`, kept for the next run. The script sets
its locale to en-US and its iPad windows to full screen before each boot.

## Dates

The simulator has the clock of the Mac, so the graph is built around the day of the run: daily
notes, file times and weekdays in the text ("by Monday") all come from that day, and the status bar
shows 9:41 on it.

## Bezels

The device frames come from [Apple Design Resources](https://developer.apple.com/design/resources/).
Their license allows them only in mock-ups of apps for Apple platforms, and not their
redistribution, so the script downloads them into `out/bezels/` (git-ignored). Never commit them.

The composed screenshots in `screenshots/` are app mock-ups, which the license allows. The bezel
PNGs on their own stay out of git.
