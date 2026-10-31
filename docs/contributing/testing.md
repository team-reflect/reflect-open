# Testing

JS tests run on [Vitest](https://vitest.dev). Rust tests are plain
`cargo test` (see `AGENTS.md`).

## Test projects

The root `vitest.config.ts` collects every app and package into one workspace.

| Project | Config | Files | Environment |
| --- | --- | --- | --- |
| `core` | `packages/core/vitest.config.ts` | `src/**/*.test.ts` | node |
| `app` | `packages/app/vitest.config.ts` | `src/**/*.test.ts` | node |
| `desktop-node` | `apps/desktop/vitest.node.config.ts` | `src/**/*.test.ts` | node |
| `desktop-browser` | `apps/desktop/vitest.browser.config.ts` | `src/**/*.test.tsx` | Playwright browser |

Every other app and package has its own `vitest.config.ts`, a node project named after the directory.

The file extension decides the environment: `.test.ts` runs in node,
`.test.tsx` runs in a real browser. There is no jsdom. A test that needs a DOM
therefore lives in `apps/desktop`, never in `packages/core` or `packages/app`.

Browser test files run in parallel. Each Vitest worker has its own Playwright
page, and Playwright emulates focus per page. CI runs the browser project on Chromium
and on WebKit, because the Tauri webview is WebKit.
`pnpm --filter @reflect/desktop test:install` downloads both browsers.
`REFLECT_TEST_BROWSER=webkit` selects WebKit, and `DEBUG=1` opens a headed browser.

## Console output fails tests

`vitest-fail-on-console` fails a test on any `console.warn` or `console.error`,
in the core, app and desktop projects.

- Fix the warning. Do not add to `apps/desktop/src/test-utils/allowed-console.ts`
  without a measured reason in that file.
- Code logs through `LoggerService`. A test of an error path passes
  `createTestLoggerService()` and asserts `logger.getErrors()`.
- In desktop tests, import `act` from `@/test-utils/act.ts`, not from `react`,
  and always await it, so no act warning prints.

## Testing a service

Construct the service under test over test doubles. Doubles live in
`packages/core/src/testing/` (`@reflect/core/testing`) and
`packages/app/src/testing/` (`@reflect/app/testing`). A double exists only for
a service that reaches the platform (files, IPC, HTTP, the clock), or whose
answers a test scripts or whose calls a test observes. A `TestXxxService` is
the service plus members that seed, drive or observe it.

- Prefer a real service over doubles one layer down. To test `TaskService`,
  use the real `NoteDocumentService` and fake only the files.
- Do not use `vi.useFakeTimers`. The test clock starts at epoch 0, and
  `clock.advance(ms)` runs the due timers.
- `createNodeTestDatabaseService()` (Node.js) and `createWasmTestDatabaseService()`
  (desktop browser tests, `@/test-utils/test-database.ts`) are real in-memory
  SQLite indexes built from the production migrations. Seed notes and assert
  query results, not SQL.

## The service containers

`createTestCoreServices({ database, ...overrides })` (`packages/core/src/testing/services.ts`)
builds `CoreServices` through the production root, `composeCoreServices`, over
test adapters. Services with a double get the double, every other service is
real. The result also holds `CoreInternalServices` (e.g. `core.database`), the
mobile services, and the `progress`, `activity` and `role` ports. Each
override replaces the factory of its key, so every service built after it
receives the override:

```ts
const noteFile = createTestNoteFileService({ files: { 'notes/a.md': '# A\n' } })
const core = createTestCoreServices({ noteFile })
```

`createTestAppServices(core, overrides)` (`packages/app/src/testing/services.ts`)
builds `AppServices` over `core`, sharing its platform and ports.

## Testing React code

Components read `useCoreServices()` and `useAppServices()`, which throw
outside their providers. Every desktop test that renders goes through
`renderInApp(ui, options)` or `renderHookInApp(hook, options)`
(`apps/desktop/src/test-utils/render-in-app.tsx`), which mount the app's
providers as `main.tsx` does. The options are documented on
`RenderInAppOptions`.

The result holds two containers:

- `core`: the core container (default: `createTestCoreServices()` over a wasm
  database). Drive and observe the graph, settings and progress here:
  `core.graphSession.setGraph()`, `core.settings.saves()`,
  `core.progress.getAll()`.
- `appServices`: the app layer, built with `createTestAppServices(core, options.appServices)`.
  Assert navigation with `appServices.navigation.navigations()`.

```tsx
const { core } = await renderInApp(<RebuildIndexField />, { graph: { indexGeneration: 7 } })
await page.getByRole('button', { name: /rebuild/i }).click()
await vi.waitFor(() => expect(core.indexLifecycle.rebuilds()).toEqual([7]))
```

**Spy before the render.** The providers read `service.method` during the
render and put that function in their context. A spy installed later is not
the function the component calls. So build your own `core`, spy on it, and pass
it in:

```tsx
const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
const rebuild = Promise.withResolvers<void>()
vi.spyOn(core.indexLifecycle, 'rebuildVisibly').mockReturnValueOnce(rebuild.promise)
await renderInApp(<RebuildIndexField />, { core, graph: { indexGeneration: 7 } })
```

With your own `core`, put the platform, the git sync service and the
connectors in it yourself. The helper throws if you also pass `platform` or
`sync`.

`database` is required: a Node.js test passes
`createNodeTestDatabaseService()`, a desktop browser test passes
`createWasmTestDatabaseService()`. `renderInApp` passes a wasm database when it
builds the app itself.

## `vi.mock`

`eslint.config.js` allows `vi.mock` only for the specifiers in
`DESKTOP_VI_MOCK_ALLOW` and `DESKTOP_VI_MOCK_ALLOW_BY_FILE`: pure UI children,
heavy children, and `@tauri-apps/*` in adapter tests. `packages/` allows none.
Never mock `@reflect/core`, `@reflect/app`, a service, or a provider that
reads a service. Seed or spy on `core` instead. A new entry needs a reason next
to it.

## Timing pitfall

Do not wait for work with one timer turn
(`await new Promise((resolve) => setTimeout(resolve, 0))`). WebCrypto digests,
wasm and IPC resolve on their own schedule, so one turn is sometimes enough,
and the test flakes. Wait for the outcome with `vi.waitFor`, or count the work
in flight as `flush()` in
`packages/core/src/assets/asset-description-service.test.ts` does.

## Browser test conventions

- Assert DOM state through locators with auto-retry:
  `await expect.element(page.getByTestId('x')).toBeVisible()`. Do not use
  `document.querySelector`.
- Prefer `getByRole`, `getByText` or `data-testid`. `page.locate('<css>')`
  (`test-utils/locator.ts`) is the escape hatch for CSS selectors.
- Count matches with `expectLocatorToHaveCount` (`test-utils/expect.ts`).
  `expect.element` picks the first match.
- Drive input with `userEvent` from `vitest/browser`. `view.rerender(<X />)`
  keeps the providers: pass only the bare element.
- A platform-specific skip needs a stated engine difference.
