# Testing

JS tests run on [Vitest](https://vitest.dev). The desktop app
(`apps/desktop`) additionally uses
[Vitest browser mode](https://vitest.dev/guide/browser/) with the Playwright
provider, so editor and component tests run in a real browser instead of
jsdom. Rust tests are plain `cargo test` (see `AGENTS.md`).

## Desktop test projects

`apps/desktop/vitest.config.ts` defines the Vitest projects:

- **`browser`**: `src/**/*.browser.test.tsx`, executed in a real browser.
  Chromium by default; WebKit on demand (see below). Test files run
  sequentially (`fileParallelism: false`) because real keyboard focus is a
  per-page global.
- **`jsdom-legacy`**: every other `src/**/*.test.{ts,tsx}` plus
  `scripts/**/*.test.mjs`, executed under jsdom. This project shrinks as the
  browser-mode migration proceeds and will eventually be replaced by a plain
  `node` project for pure-logic tests.

The target routing rule: `.test.ts` means "pure logic, node environment",
`.test.tsx` means "needs a DOM, real browser". Exceptions are listed
explicitly in the config.

## Browsers

Chromium is the default. WebKit matters because the production desktop app
renders in a Tauri `WKWebView`, which is WebKit; CI runs both on every PR.
Firefox is intentionally not part of the matrix.

```bash
# one-time: download the browsers
pnpm --filter @reflect/desktop test:install

# run the browser project on Chromium
pnpm --filter @reflect/desktop exec vitest run --project browser

# same, on WebKit
REFLECT_TEST_BROWSER=webkit pnpm --filter @reflect/desktop exec vitest run --project browser

# watch a headed browser window while debugging
DEBUG=1 pnpm --filter @reflect/desktop exec vitest --project browser path/to/test
```

## Console output fails tests

`vitest-fail-on-console` turns any `console.warn` / `console.error` during a
test into a failure, in every desktop project. Noise that predates the check
is silenced by regex in `apps/desktop/src/test-utils/allowed-console.ts`.
The rules:

- PRs may only shrink the allowlist (fix the warning, then delete its regex).
- A new entry needs a stated reason in the PR.
- An intentionally exercised error path should assert on the log instead:
  `vi.spyOn(console, 'error').mockImplementation(() => {})`.

## Browser test conventions

- Assert DOM state through locators with auto-retry:
  `await expect.element(page.getByTestId('x')).toBeVisible()`. No
  `document.querySelector`, no `vi.waitFor` around DOM reads (`vi.waitFor`
  stays for spy assertions and geometry reads).
- `page.locate('<css>')` (registered by `src/test-utils/locator.ts`) is the
  escape hatch for CSS selectors; prefer semantic locators (`getByRole`,
  `getByText`) or `data-testid`. Third-party intrinsic classes
  (`.ProseMirror`) are fine to locate.
- Counting matches needs `expectLocatorToHaveCount` from
  `src/test-utils/expect.ts` (`expect.element` silently picks the first
  match).
- Mount React components with `render` from `vitest-browser-react`; drive
  input with `userEvent` from `vitest/browser` (real key events, no
  `setup()`).
- The app stylesheet (`src/styles/index.css`, Tailwind included) is loaded in
  every browser test via `src/test-utils/setup-browser.ts`, so layout is
  real.
- Platform-specific skips need a stated engine difference, not a convenience
  skip.
