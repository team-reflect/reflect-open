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

`pnpm dev:ios` does the same without Xcode: it starts its own dev server on port 1420 (stop any other server there first), builds the app, and launches
it in the "iPhone 17" simulator with `REFLECT_DEV_URL`.
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
pnpm test:ios    # the same run as the test-ios CI job
```

`pnpm test:ios` builds the web app and the Rust core, creates a simulator for the run, builds the
app and its tests, runs the Reflect test plan, and deletes the simulator. It prints the time of
each step. The result bundle goes to `apps/ios/build/test-ios`; open it in Xcode for the
screenshots and the steps of each test. After a failed test run that directory also holds the log
of the simulator.

| Tests | Where they run |
| --- | --- |
| Logic of a module in `apple/` (for example the store commands in `AppStoreKit`) | macOS, `pnpm test:swift` |
| `apps/ios/Tests`: code that needs the app target or the Rust core | simulator, inside the app |
| `apps/ios/UITests/GoldenPathUITests.swift`: one path through the real app | simulator |

Rules for a test in the simulator:

- **Put logic in an `apple/` module and test it there** with a fake for the system framework. A
  test in the simulator shows only that the parts connect.
- **No test depends on a system service of the simulator** such as the StoreKit test session. Its
  result changes from one new simulator to the next. Check real purchases with a sandbox account
  on TestFlight (see `docs/distribution.md`).
- **A UI test calls `app.useSession(UUID())` before the first launch.** The app then keeps its
  data in a place of its own and starts with finished onboarding (`AppDirectories.swift`, Debug
  builds only), so a test does not depend on the data of another test or of the developer.
- **Wait for a condition** with `XCUIApplication.patience` as the timeout. Do not wait for a
  fixed time: the first launch of an app on a new simulator can take minutes.
- **Add a step to the golden path before you add a UI test.** Each launch of the app costs
  seconds to minutes.
