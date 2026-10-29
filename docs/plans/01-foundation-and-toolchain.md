# Plan 01 — Foundation & Toolchain

**Goal:** Turn the default Tauri scaffold into a conventions-compliant app shell with
the frontend toolchain, IPC conventions, design system, and test/lint harness every
later phase builds on.

**Depends on:** nothing (repo is already a Tauri 2 + React 19 + Vite + TS scaffold).
**Unlocks:** all phases.

See [Architecture & Conventions](architecture-conventions.md) for the monorepo layout,
the TS-core/Rust-primitives split, the actions pattern, and Kysely discipline.

## Scope

**In:** monorepo restructure (Turborepo + pnpm workspaces + `tsc -b` project refs),
toolchain config, Tailwind/shadcn/Lucide, zod, Kysely, path aliases, the Rust↔TS IPC
bridge, design-system integration, vitest + lint, app-shell skeleton, a Tauri sanity
check.
**Out:** product features (editor, files, search) start in Plan 02+.

## Steps

1. **Monorepo (lightweight).** Move the scaffold into `apps/desktop/`. Create
   `packages/core` (`@reflect/core`, TS actions/business logic) and `packages/db`
   (`@reflect/db`, Kysely schema/types + IPC dialect, wired in Plan 04). Do **not**
   pre-create empty `apps/cli` or `apps/extension`; they arrive with Plans 14 and 11.
2. **Strip the template** (`greet` demo) and replace `App.tsx` with an empty shell
   (sidebar rail + main pane + right sidebar slot).
3. **Frontend libraries:** Tailwind v4, shadcn/ui (confirm a component exists under
   `components/ui` before adding it, a repo rule), Lucide, zod (all runtime
   validation), Kysely (driver in Plan 04), react-hook-form, `clsx` + `tailwind-merge`,
   and `@meowdown/react` + `@meowdown/core` (Plan 05's editor; first-party MIT, no
   licensing constraint).
4. **Path aliases:** `@/` for in-app imports; workspace names (`@reflect/core`,
   `@reflect/db`) across packages.
5. **Design system.** `design-system/` ships Inter, indigo `#4F46E5` tokens, light/dark
   scopes, and React primitives. Decision: import its `styles.css` for tokens/fonts and
   write component styles in Tailwind, so shadcn and the DS share one token source.
   Theme follows the OS.
6. **IPC bridge convention (reused everywhere).** It lives in `@reflect/core`, not the
   app shell:
   - Rust commands are `snake_case` `#[tauri::command]`s returning
     `Result<T, AppError>`.
   - Components never call `invoke` directly. A thin IPC layer wraps each command,
     validates the response with zod, and **normalizes snake_case → camelCase at this
     boundary**; components only see validated camelCase types.
   - `AppError` is a discriminated union (`kind: 'io' | 'parse' | ...`) so the UI can
     branch with type guards.
7. **App shell:** left nav rail, center note pane, right sidebar slot (copilot later).
   Focus regions defined now so Plan 06+ can wire shortcuts.
8. **Tauri sanity check + two go/no-go gates.** The repo commits to Tauri ("No Electron.
   Desktop shell is Tauri."). A de-risking spike confirms on macOS: Rust file IO, the
   WebView-hosted **meowdown** editor (mount, type, `docToMarkdown` round-trip), loading
   a native SQLite extension, OS keychain, native menus/global shortcuts, **durable
   folder access** (TCC behavior for `~/Documents`/iCloud; security-scoped bookmarks
   only under sandbox, Plan 02), and **cloud-sync-folder detection**. Two findings gate
   later phases:
   - **meowdown wiki-link extension:** prototype `[[ ]]` as a `@lezer/markdown` inline
     rule + PM node + `[[` autocomplete. Wiki-links are Reflect's core primitive and
     meowdown has none; if this cannot feel good, the editor decision changes *now*
     (fallback: CodeMirror-6 live-preview), before Plans 06–10 depend on it.
   - **SQLite extensions load in the bundled Rust SQLite** (FTS5 now, `sqlite-vec` later).
   Record findings in the relevant plan; surface a failed gate before Plan 02/05.
9. [x] **Testing + lint.** Desktop `.test.tsx` suites run in real browsers (Vitest
   browser mode + Playwright); pure `.test.ts` suites run in node. CI runs Chromium and
   WebKit on every PR, plus node and lint.
10. **Housekeeping:** dev/build/test/typecheck scripts work; MIT `LICENSE` placeholder
    (finalized in Plan 15); `.gitignore` covers `dist/`, `.reflect/`, and `target/`.

## Key decisions / contracts

- **One IPC boundary module** owns zod validation + casing normalization. No component
  imports `@tauri-apps/api` directly. This enforces "normalize casing at boundaries"
  and "zod for all incoming data."
- **`AppError` discriminated union** is the shared error contract for all commands.
- **Design tokens have a single source** (DS `styles.css`) for shadcn and custom code.

## Acceptance criteria

- `pnpm tauri dev` shows the empty three-region shell with DS fonts, brand color, and
  light/dark that follows the OS.
- A trivial command (e.g. `app_version`) goes through the IPC wrapper, zod-validated.
- `pnpm typecheck` and `pnpm test` pass; no `any`.
- Spike findings recorded in the relevant plan.

## Risks

- **shadcn + Tailwind v4 + DS token collisions.** Choose one token source early
  (step 5) and add a token-mapping test.
- **Tauri building-block gaps** (extension loading, keychain). The spike (step 8)
  finds them before they cost a phase.
