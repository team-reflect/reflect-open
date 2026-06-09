# Plan 01 — Foundation & Toolchain

**Goal:** Turn the default Tauri scaffold into a clean, conventions-compliant app shell
with the frontend toolchain, IPC conventions, design system, and test/lint harness that
every later phase builds on.

**Depends on:** nothing (repo is already a Tauri 2 + React 19 + Vite + TS scaffold).
**Unlocks:** all phases.

See [Architecture & Conventions](architecture-conventions.md) for the monorepo layout,
the TS-core/Rust-primitives split, the actions pattern, and Kysely discipline this phase
stands up.

## Scope

**In:** monorepo restructure (Turborepo + pnpm workspaces + `tsc -b` project refs),
dependency install + config, Tailwind/shadcn/Lucide, zod, Kysely, path aliases, the
Rust↔TS IPC bridge pattern, design-system integration, vitest + lint, app-shell layout
skeleton, a Tauri shell sanity check.
**Out:** any product features (no editor, files, search). Those start in Plan 02+.

## Steps

1. **Restructure into the monorepo (lightweight).** Move the existing scaffold into
   `apps/desktop/` (its `src/` + `src-tauri/` + `dist/`). Create `packages/core`
   (`@reflect/core` — the TS actions/business-logic home) and `packages/db` (`@reflect/db`
   — Kysely schema/types + the IPC dialect, wired in Plan 04). Add `pnpm-workspace.yaml`
   (`apps/*`, `packages/*`), `turbo.json` (dev/build/lint/test/typecheck), root `tsconfig`
   with project references, and `@reflect/*` names. Do **not** pre-create empty `apps/cli`
   or `apps/extension` — they arrive at Plans 14 and 11. Confirm `pnpm tauri dev` works
   from `apps/desktop`.

2. **Strip the template.** Remove the `greet` demo from `apps/desktop/src/App.tsx` and the
   matching `greet` command in `apps/desktop/src-tauri/src/lib.rs` (keep the registration
   pattern as the reference for real commands). Replace `App.tsx` with an empty app-shell
   layout (sidebar rail + main pane + right sidebar slot) using placeholder regions.

3. **Frontend libraries.** Add and configure (with `pnpm --filter` per package):
   - `tailwindcss` + `@tailwindcss/vite` (v4), wire `styles.css`.
   - `shadcn/ui` (init; components land in `src/components/ui`). Confirm a component
     exists under `components/ui` before adding it — repo rule.
   - `lucide-react` for icons.
   - `zod` for all runtime validation.
   - `kysely` for typed SQL building (driver lands in Plan 04).
   - `react-hook-form` for any forms (preferences, provider keys later).
   - `clsx` + `tailwind-merge` (shadcn `cn` helper).
   - `@meowdown/react` + `@meowdown/core` (the editor, Plan 05) and their ProseKit/Lezer
     peers. First-party and MIT — no licensing constraint.

4. **Path aliases.** Configure `@/` → `apps/desktop/src/` in `tsconfig.json`
   (`paths`) and `vite.config.ts` (`resolve.alias`). In-app imports use `@/`;
   cross-package imports use the workspace names (`@reflect/core`, `@reflect/db`).

5. **Design system.** The `design-system/` package ships Inter, indigo `#4F46E5`
   brand tokens, light/dark theme scopes, and React primitives. Decide and document:
   either (a) consume `design-system/styles.css` + tokens directly, or (b) map tokens
   into the Tailwind theme. Recommended: import `styles.css` for tokens/fonts and
   express component styles in Tailwind so shadcn and the DS share one token source.
   Build a `ThemeProvider` (light/dark, follows OS) as a provider + `useTheme` hook.

6. **IPC bridge convention (critical, reused everywhere).** This layer lives in
   `@reflect/core` (per [Architecture & Conventions](architecture-conventions.md)) — the
   actions core, not the app shell, owns it. Establish the single pattern for calling Rust:
   - Rust commands are `#[tauri::command]`, registered in `invoke_handler`, named
     `snake_case`, returning `Result<T, AppError>` with a serializable `AppError`.
   - The frontend never calls `invoke` directly from components. Instead a thin
     `src/lib/ipc/` layer wraps each command, validates the response with a zod schema,
     and **normalizes snake_case → camelCase at this boundary**. Components and hooks
     only see camelCase, validated types.
   - Define `AppError` as a discriminated union (e.g. `kind: 'io' | 'parse' | ...`)
     so the UI can branch with type guards.

   ```ts
   // src/lib/ipc/invoke.ts
   import { invoke } from '@tauri-apps/api/core'
   import type { ZodType } from 'zod'

   /** Calls a Tauri command and validates+normalizes the result. */
   export async function call<TOut>(
     command: string,
     args: Record<string, unknown>,
     schema: ZodType<TOut>,
   ): Promise<TOut> {
     const raw = await invoke(command, args)
     return schema.parse(raw)
   }
   ```

7. **App-shell layout.** A `AppShell` component: left nav rail, center note pane, right
   sidebar slot (copilot later). Keyboard focus regions defined now so Plan 06+ can wire
   shortcuts. No business logic yet.

8. **Tauri shell sanity check + two go/no-go gates.** The repo commits to Tauri (AGENTS.md:
   "No Electron. Desktop shell is Tauri."). Run the product-vision's intent as a *de-risking
   spike*: confirm on macOS that the real building blocks work end-to-end — local file
   read/write from Rust, the WebView-hosted **meowdown** editor (mount, type,
   `docToMarkdown` round-trip), loading a native SQLite extension (FTS5/`sqlite-vec`) in
   Rust, OS keychain access, native menus/global shortcuts, **durable folder access**
   (TCC prompt behavior for `~/Documents`/iCloud; and whether a security-scoped bookmark is
   needed — only under sandbox, Plan 02), and **cloud-sync-folder detection**. Two findings
   are **go/no-go gates** that must pass before later phases pile on:
   - **meowdown wiki-link extension** — prototype `[[ ]]` as a `@lezer/markdown` inline rule
     + PM node + `[[` autocomplete in meowdown. Wiki-links are Reflect's core primitive and
     meowdown has none; if this can't be made to feel good, the editor decision changes
     *now* (fallback: CodeMirror-6 live-preview) — before Plans 06–10 depend on it.
   - **SQLite extensions load in the bundled Rust SQLite** (FTS5 now, `sqlite-vec` later).
   Capture findings in `docs/spikes/`. If a gate fails, surface it before Plan 02/05.

9. **Testing + lint.** Add `vitest` + `@testing-library/react` + `jsdom` for unit/UI logic.
   **Editor tests need a real browser** (ProseMirror/contenteditable doesn't work under
   jsdom) — add **browser-mode vitest** (`@vitest/browser` + playwright), the same setup
   meowdown itself uses. Wire `pnpm test`, `pnpm typecheck` (already `tsc`), and the repo's
   `oxlint` adherence config from `design-system/_adherence.oxlintrc.json` where
   applicable. CI runs lint; locally we run typecheck + targeted tests.

10. **Scripts & housekeeping.** Ensure `pnpm dev`, `pnpm tauri dev`, `pnpm build`,
   `pnpm test`, `pnpm typecheck` all work. Add an MIT `LICENSE` placeholder (finalized in
   Plan 15). Confirm `.gitignore` covers `dist/`, `.reflect/` (project-level), and Rust
   `target/`.

## Key decisions / contracts

- **One IPC boundary module** owns zod validation + casing normalization. No component
  imports `@tauri-apps/api` directly. This is the enforcement point for "normalize
  casing at boundaries" and "zod for all incoming data."
- **`AppError` discriminated union** is the shared error contract for all commands.
- **Design tokens have a single source** (DS `styles.css`) consumed by both shadcn and
  custom components.

## Acceptance criteria

- `pnpm tauri dev` launches an app showing the empty three-region shell with DS fonts,
  brand color, and working light/dark toggle that follows OS.
- A trivial round-trip command (e.g. `app_version`) is called through the `call()`
  wrapper, zod-validated, and rendered.
- `pnpm typecheck` and `pnpm test` pass; no `any` in the codebase.
- Spike note committed under `docs/spikes/`.

## Risks

- **shadcn + Tailwind v4 + DS token collisions.** Mitigate by choosing one token source
  early (step 4) and a token-mapping test.
- **Tauri building-block gaps** (extension loading, keychain). The spike (step 7) exists
  to find these before they cost a phase.
