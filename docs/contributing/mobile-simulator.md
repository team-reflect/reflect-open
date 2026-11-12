# Running the iOS simulator

The iOS app is the Swift shell in `apps/ios`. It loads the web app from
`apps/ios/Web`, a link to `apps/web/dist/mobile`.

```bash
mise install                                   # cbindgen and other tools from mise.toml
pnpm install                                   # also writes apps/ios/.xcode.env.local
pnpm --filter @reflect/ios build:web           # apps/web/dist/mobile
pnpm build:ffi --debug --sdk iphonesimulator   # the Rust core
open apps/ios/Reflect.xcodeproj                # run the Reflect scheme
```

The `Debug-Dev` configuration is the dev flavor (`app.reflect.ios.dev`, "Reflect Dev"). For hot
reload, run `pnpm --filter @reflect/ios dev:web` and enable `REFLECT_DEV_URL` in the scheme's
environment variables.
On a physical device, run `pnpm --filter @reflect/ios dev:web --host` and point
`REFLECT_DEV_URL` at the Mac's LAN address.

With "Connect Hardware Keyboard" on (I/O → Keyboard, ⇧⌘K), the simulator shows no software
keyboard and `--keyboard-height` stays 0. Turn it off to test keyboard avoidance.

## Evaluating JavaScript in the web view

`pnpm web-inspector` connects to the Web Inspector of the booted simulator and serves an HTTP
endpoint on localhost. The request body is a JavaScript expression. The response is JSON with the
awaited `value`, or an `error`.

```bash
pnpm web-inspector
curl -d 'document.title' http://127.0.0.1:9229
curl -d 'fetch("/index.html").then((r) => r.status)' http://127.0.0.1:9229
```

The web view must be inspectable (`WKWebView.isInspectable`). The connection reopens after the
app restarts.

## Testing the iOS app

```bash
pnpm test:ios                   # the Reflect test plan, the same run as the test-ios CI job
pnpm test:ios --plan Nightly    # also the tests of the nightly workflow
```

`pnpm test:ios` creates a simulator for the run, builds the app and its tests, runs one test plan
of the Reflect scheme, and deletes the simulator. It prints the path of the result bundle; open it
in Xcode for the screenshots and the steps of each test. After a failure it also saves the log of
the simulator. `scripts/test-ios.ts` lists the options.

| Tests | Where they run | Test plan |
| --- | --- | --- |
| Logic of a module in `apple/` (for example the store commands in `AppStoreKit`) | macOS, `pnpm test:swift` | none |
| `apps/ios/Tests`: code that needs the app target or the Rust core | simulator, inside the app | Reflect, Nightly |
| `apps/ios/UITests/GoldenPathUITests.swift`: one path through the real app | simulator | Reflect, Nightly |
| Tests that depend on system services of a new simulator (`StoreKitSessionTests`, `EntryPointUITests`) | simulator | Nightly |

Rules for a test in the simulator:

- **Put logic in an `apple/` module and test it there** with a fake for the system framework. A
  test in the simulator shows only that the parts connect.
- **A UI test calls `app.useSession(UUID())` before the first launch.** The app then keeps its
  data in a place of its own and starts with finished onboarding (`AppDirectories.swift`, Debug
  builds only), so a test does not depend on the data of another test or of the developer.
- **Wait for a condition** with `XCUIApplication.patience` as the timeout. Do not wait for a
  fixed time: the first launch of an app on a new simulator can take minutes.
