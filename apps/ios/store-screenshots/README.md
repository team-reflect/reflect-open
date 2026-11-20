# App Store screenshots

```bash
pnpm store-screenshots
```

Writes the five screenshots of each App Store size to `screenshots/<device>/`, ready to upload.
They are committed, so a run shows its changes in the diff. It takes about 5 minutes, most of it in
the simulator.

| Device | Simulator | Size (px) |
| --- | --- | --- |
| `iPhone-18-Pro` | iPhone 18 Pro | 1206 × 2622 |
| `iPhone-Duo-outer` | iPhone Duo, closed | 1398 × 2034 |
| `iPad-Pro-13-inch-M5-landscape` | iPad Pro 13-inch (M5), landscape | 2752 × 2064 |

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
   (Debug builds only): notes, settings, the AI key, the answer of the AI provider, and
   `localStorage`.
3. **Compose** (`compose.ts`): the caption of `copy.ts` and the raw screen in Apple's bezel, the
   caption above a portrait device and left of a landscape one.

Each device has its own simulator, `reflect-store-<device>`, kept for the next run. Before each
boot, the script sets its locale to en-US and its iPad windows to full screen. It closes the
iPhone Duo with `duo-close.m`, and the test turns the iPad to landscape, which shows the sidebar.

## Dates

The simulator has the clock of the Mac, so the graph is built around the day of the run: daily
notes, file times and weekdays in the text ("by Monday") all come from that day, and the status bar
shows 9:41 on it.

## Bezels

The device frames come from [Apple Design Resources](https://developer.apple.com/design/resources/).
Their license allows them only in mock-ups of apps for Apple platforms, and not their
redistribution, so the script downloads them into `out/bezels/` (git-ignored). Never commit them.
The composed screenshots in `screenshots/` are app mock-ups, which the license allows.
