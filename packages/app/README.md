# @reflect/app

The app layer of Reflect: windows, routes, commands, menus, update, theme and
the boot flows. It builds on [`@reflect/core`](../core/README.md) and knows
nothing of React or Tauri, so `apps/desktop` keeps only the adapters and the UI.
Which package a service belongs in is decided in
[services.md](../../docs/contributing/services.md).

## The root

`createAppServices(core, host)` (`src/create-app-services.ts`) builds every app
service once per webview, over the `CoreServices` that `createCoreServices`
returned. React reads it with `useAppServices()`.

`AppHost` is what the host supplies. The host builds its `window`, `lifecycle`
and `operations` services before core, because core uses them as its `role`,
`activity` and `progress` ports. The desktop builds its host in
`apps/desktop/src/services/create-desktop-services.ts` (`createDesktopHost`).

`createAppGraphServices` (`src/graph/graph-lifecycles.ts`) is the
`CoreAdapters.createGraphServices` the desktop passes to core. It decides which
graph lifecycles run in this window.

Each directory under `src/` is one domain; `src/testing/` is the
`@reflect/app/testing` entry.

## Testing

`@reflect/app/testing` holds the app doubles, `createTestAppHost(overrides)`,
and `createTestAppServices(core, overrides)`. Tests run in the `app` project
(node). A test that needs a DOM belongs in `apps/desktop`.

## Lint boundary

`eslint.config.js` stops this package from importing React, TanStack,
`@tauri-apps/*` or anything under `apps/`, and applies the core rules: no
default instances, no module-level `let`, and the class shape.
