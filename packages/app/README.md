# @reflect/app

The app layer of Reflect: windows, routes, commands, menus, update, theme and
the boot flows. It builds on [`@reflect/core`](../core/README.md) and knows
nothing of React or Tauri, so `apps/desktop` keeps only the adapters and the UI.
Which package a service belongs in is decided by "Core, app, or desktop?" in
[services.md](../../docs/contributing/services.md).

## The root

`createAppServices(core, host)` (`src/create-app-services.ts`) builds every app
service once per webview, over the `CoreServices` that `createCoreServices`
returned, and returns `AppServices`. React reads it with `useAppServices()`.

`AppHost` is what the host supplies: the window, lifecycle and operations
services, dialogs, clipboard, opener, and the optional media queries, exception
telemetry, updater and native menu host. The host builds `window`, `lifecycle`
and `operations` before core, because core uses them as its `role`, `activity`
and `progress` ports. The desktop builds its host in
`apps/desktop/src/services/create-desktop-services.ts` (`createDesktopHost`).

`createAppGraphServices` (`src/graph/graph-lifecycles.ts`) is the
`CoreAdapters.createGraphServices` the desktop passes to core. It decides which
graph lifecycles run in this window.

## Directories

| Module | What it owns |
|---|---|
| `app/` | `WindowService`, `AppLifecycleService`, `OperationsService`, `QuitPolicyService`, `PlatformService`, `UpdateService`, `ExceptionTelemetryService`, and the dialog, clipboard and opener services. |
| `graph/` | `GraphBootService` (the window-aware graph flows), `MobileOnboardingService`, and the graph lifecycles. |
| `navigation/` | `NavigationService`, `Route`, `DeepLinkRouter`, `LinkNavigationService`, and the deep-link to route mapping. |
| `commands/` | `CommandService`, `KeymapService`, `NativeMenuService`, and the keybinding and accelerator rules. |
| `search/` | `PaletteSearchService`, `AutocompleteSuggestionService`, and the All-notes filter model. |
| `daily/` | The day-window, week-window and month-grid arithmetic of the daily surfaces. |
| `calendar/` | `CalendarEventsService`, the daily note's events panel. |
| `settings/` | `ThemeService`. |
| `sync/` | `getMobileSyncStatus` and the connect-GitHub wizard. |
| `mobile/` | `KeyboardService` and `ShareService`. |
| `testing/` | The `@reflect/app/testing` entry. |

## Testing

`@reflect/app/testing` holds the app doubles, `createTestAppHost(overrides)`,
and `createTestAppServices(core, overrides)`, which builds `AppServices` over
`createTestCoreServices()` by default. Tests run in the `app` project
(node, `src/**/*.test.ts`). A test that needs a DOM belongs in `apps/desktop`.

## Lint boundary

`eslint.config.js` stops this package from importing React, TanStack,
`@tauri-apps/*` or anything under `apps/`, and applies the core rules: no
default instances, no module-level `let`, and the class shape.
