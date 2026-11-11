# Running the iOS simulator

The iOS app is the Swift shell in `apps/ios`. It loads the web app from
`apps/ios/Web`, a link to `apps/web/dist/mobile`.

```bash
pnpm --filter @reflect/ios build:web           # apps/web/dist/mobile
pnpm build:ffi --debug --sdk iphonesimulator   # the Rust core
open apps/ios/Reflect.xcodeproj                # run the Reflect scheme
```

The Debug configuration is the dev flavor (`app.reflect.ios.dev`, "Reflect Dev"). For hot
reload, run `pnpm --filter @reflect/ios dev:web` and enable `REFLECT_DEV_URL` in the scheme's
environment variables.

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
