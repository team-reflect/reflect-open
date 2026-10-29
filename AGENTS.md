### Purpose

This document tells AI agents how to work in the Reflect repo safely.

### What is Reflect

Reflect is a note‑taking tool with a TypeScript codebase. This repo is Reflect V2, a rewrite of the original Reflect to make it offline-first, markdown backed, and open source.

### Product Principles

Context: [V1 Overview](docs/reflect-v1-overview.md) · [V2 Product Vision](docs/reflect-v2-product-vision.md) · [V2 Grounding Brief](docs/reflect-v2-grounding-brief.md) · [Indexing Strategy](docs/reflect-v2-indexing-strategy.md) · [Sync Strategy](docs/reflect-v2-sync-strategy.md)

- **Daily notes first.** The app opens to today's note. All capture flows into the daily note by default.
- **Association over hierarchy.** `[[Wiki Links]]` and the note graph organize notes. There are no folders.
- **Markdown is the source of truth.** Notes are `.md` files (`daily/YYYY-MM-DD.md`, `notes/`). SQLite under `.reflect/` is a rebuildable projection of the notes, with one durable exception: the `chat_*` tables hold AI chat history, which markdown cannot rebuild. Index wipes and rebuilds must leave them untouched.
- **No Reflect-hosted APIs, BYOK AI.** LLM calls go directly to user-approved providers (OpenAI, Anthropic, etc.) with user-supplied keys. Sync goes to GitHub/iCloud/Git. Never proxy through Reflect infrastructure, and never assume Reflect operates AI infrastructure.
- **`private: true` is a hard block.** Content of notes with this frontmatter flag must never reach any external service (AI, transcription, or other). Enforce at every call site.
- **Keyboard-native UX.** Every core workflow must be reachable from the keyboard. This is product identity, not polish.
- **Minimal UI.** Do less, and do it well. Don't add surfaces that compete with the editor.
- **Secrets in the OS keychain.** API keys and credentials never go in markdown, Git, or `.reflect/`.
- **Portable data.** Full export (JSON, markdown, HTML) must work from day one.
- **No Electron.** The desktop shell is Tauri.
- **MIT open-source core.** Write as if the code is public and will be critiqued.

### Agent workflow

- **Verify before answering.** For factual questions about the code, read the
  source and trace behavior to the final output. If you have not verified
  something, say so instead of guessing.
- **Plan proportionally.** For non-trivial, ambiguous, or high-risk changes, form a
  short plan first. Ask for sign-off when the direction affects public APIs,
  migrations, release behavior, or broad UX. Simple localized fixes can proceed once
  you understand the context.
- **Use a dedicated worktree or branch.** Check `git status` before editing and
  before staging. Preserve unrelated user changes. Ask before publishing if the
  worktree is dirty, the PR scope is ambiguous, or staging would include changes
  you did not make.
- **Prefer the clean design.** Optimize for the correct open-source shape, not the
  smallest diff. Avoid compatibility shims, dual paths, or legacy behavior unless the
  product or release context requires them.
- **Verify locally.** Before you declare work done, run the build, `pnpm check`
  (typecheck + lint; `pnpm fix` auto-fixes lint where possible), and the targeted
  tests for the code you touched. If a required check cannot run, report the reason and the residual risk.
- **Publish completed work.** When a requested implementation is complete and
  verified, commit the intended changes on an appropriate branch, push, open a normal
  ready-for-review PR, and wait for CI, Bugbot, review comments, merge conflicts, and
  other blockers to settle.

### Development workflow

`master` is the only long-lived branch: branch from it and target it with PRs.
release-please keeps a beta and a stable Release PR open side by side; merging one
publishes that channel. Between stable releases the version carries a prerelease
suffix (`0.7.0-beta.3`), published as GitHub pre-releases. See
[docs/distribution.md](docs/distribution.md).

PR titles must be conventional commits (`feat:` / `fix:` / `chore:` …, enforced by
CI). The title becomes the squash-commit message, drives the version bump, and, for
`feat`/`fix`, is the user-facing changelog entry, so write it as behavior, not
implementation. Do not use `feat!:` or `BREAKING CHANGE:` footers. See
[CONTRIBUTING.md](CONTRIBUTING.md).

release-please owns the app version in `apps/desktop/package.json`. Never hand-edit
that version, the changelogs (`apps/desktop/CHANGELOG.md`,
`apps/desktop/CHANGELOG.beta.md`), or the manifests under `.github/release-please/`.

### Running tests

There are too many tests to run them all. Run only the ones for the logic you wrote:
`pnpm test --run path/to/test`.

Desktop JS tests are split into Vitest projects (details in
`docs/contributing/testing.md`):

- `*.test.tsx` files run in a real browser (Vitest browser mode + Playwright).
  Chromium by default; `REFLECT_TEST_BROWSER=webkit` runs WebKit (the engine of the
  production Tauri webview); `DEBUG=1` opens a headed window. One-time setup:
  `pnpm --filter @reflect/desktop test:install`.
- `*.test.ts` files are pure logic and run in node. A logic test that drives the DOM
  is named `.test.tsx` so it lands in the browser project.
- `console.warn` / `console.error` fail tests in the core, app and desktop projects.
  A new entry in the allowlist `apps/desktop/src/test-utils/allowed-console.ts` needs
  a measured reason in that file.

Rust tests: prefer per-crate runs (`cargo test -p reflect-cli`,
`cargo test -p reflect-open`); `cargo test --workspace` also works.

**Before any cargo build/check/test that compiles the desktop crate** (including
`--workspace` commands and clippy), stage the sidecars once per checkout:
`pnpm --filter @reflect/desktop sidecar`. Otherwise tauri-build fails with
`resource path binaries/<name>-<triple> doesn't exist` (`pnpm tauri dev`/`build`
stage them automatically; see [docs/cli.md](docs/cli.md)). Clippy and the tests never
run the sidecars, so they can skip them, as CI does:
`TAURI_CONFIG='{"bundle":{"externalBin":null}}' cargo clippy --workspace --all-targets`.

Rust lint warnings fail the build (`.cargo/config.toml`). Use
`CARGO_BUILD_WARNINGS=warn` while iterating.

### Repo layout

A **Turborepo + pnpm monorepo** around a **Tauri 2** desktop/mobile app: a React +
TypeScript frontend bundled by Vite, in a Rust native shell. The Rust crates form one
**Cargo workspace** at the repository root.

- `apps/desktop/`: the Tauri 2 app (`src/` React frontend, `src-tauri/` Rust crate
  `reflect-open`). Never hand-edit `src-tauri/gen/`.
- `apps/cli/`: `reflect`, the Rust read/discovery CLI ([docs/cli.md](docs/cli.md)).
- `apps/extension/`: the Chrome capture extension; `apps/native-host/`: its
  native-messaging sidecar `reflect-capture-host` (Plan 11).
- `packages/core/`, `packages/app/`, `packages/db/`: see Services below and each
  package's README.
- `crates/index-schema/`: the SQLite migrations shared by the desktop writer and the
  CLI reader.
- `design-system/`, `docs/` (product and architecture docs, `docs/plans/`).

### Sync

Read the sync safety rules in [docs/git-backup-safety.md](docs/git-backup-safety.md) (S1 to S9) before you change `git/`, `conflict/`, `icloud/`, `fs/` or `packages/core/src/sync/`.

- **TS owns policy.** Cadence, single-flight queueing and status live in `packages/core/src/sync/`. Rust owns the capabilities: `git/` (libgit2 commit, fetch, merge, push) and `icloud/` (sweep, versions, watch).
- **Conflicts.** `.md` notes go through `conflict/ladder.rs` (also used by `note_write`). Other files get a conflict copy from `conflict/copy.rs`. See S7.
- **One lock per graph.** `fs/graph_lock.rs` serializes git commands, note writes and sweep writes. Take it before you touch notes in Rust. `git_fetch` and `git_remote_head` run outside it.
- **Own writes.** `fs/own_writes.rs` records the note bytes this process wrote, so a later read can tell its own content from a change that arrived from elsewhere.

### Related repos

- **Meowdown** (`~/repos/meowdown`) is the first-party live-preview Markdown editor
  that Reflect uses through `@meowdown/core` and `@meowdown/react`. For editor
  behavior, markdown round-tripping, keybindings, slash menus, wiki links, task
  checkboxes, paste/drop, or mobile editor quirks, check that repo too. If the root
  cause is in Meowdown, fix it there and open the PR against Meowdown instead of
  papering over it in Reflect.

**Design system**

All UI work follows the Reflect design system in [`design-system/readme.md`](design-system/readme.md).

**Services (how TypeScript code is wired)**

Read [docs/plans/architecture-conventions.md](docs/plans/architecture-conventions.md)
and [docs/contributing/services.md](docs/contributing/services.md) before adding logic.
The short version:

- Three packages: `@reflect/core` (business logic, platform primitive interfaces),
  `@reflect/app` (windows, routes, commands, menus, update, theme, boot flows),
  `apps/desktop` (React, Tauri adapters). A product rule every client needs goes in
  core; windows, routes, menus and pixels go in app; React goes in desktop. Lint keeps
  React, TanStack and Tauri out of both packages.
- A service is `createXxxService(deps)` in `<package>/src/<domain>/<name>-service.ts`;
  it gets other services only through `deps`.
- Two roots: `createCoreServices(adapters)` and `createAppServices(core, host)`, both
  built in `apps/desktop/src/boot.ts`. Never import from `boot.ts` outside `main.tsx`
  and the platform roots.
- React reads `useCoreServices()` and `useAppServices()`; commands read
  `CommandContext.services` and `.app`.
- Rust-boundary wrappers (`NoteFileService`) take an explicit `generation`. User-facing
  services read the `GraphSession` once at method entry and pass its generations down.
- Tests build services over `@reflect/core/testing` and `@reflect/app/testing`;
  desktop tests render with `renderInApp`. `vi.mock` only for the allowlist in
  `eslint.config.js`. See [docs/contributing/testing.md](docs/contributing/testing.md).

**Frontend ↔ Rust**

- Define commands with `#[tauri::command]` in `apps/desktop/src-tauri/src/` and
  register them in `lib.rs`'s `invoke_handler`.
- Bind each command as a method of the core service that owns the domain, through `ipc.call(command, args, zodSchema)`. Components never call `invoke`. See [docs/contributing/adding-a-command.md](docs/contributing/adding-a-command.md).
- Add Tauri plugins in `apps/desktop/src-tauri/Cargo.toml` (Rust) and grant permissions in `apps/desktop/src-tauri/capabilities/`.

**Common commands** (run from the repo root; the rest are in `package.json`)

```bash
pnpm dev              # Vite on http://localhost:1420; add ?platform=ios to preview the
                      #   MOBILE tree in a plain browser (in-memory IPC + seeded demo graph)
pnpm tauri dev        # Full Tauri app with hot reload
pnpm tauri:dev        # The "Reflect Dev" flavor (green icon, own identifier; coexists with Reflect / Reflect Beta)
pnpm tauri:ios:dev "iPhone 17 Pro"  # The iOS target in the simulator
```

The mobile app is the Tauri iOS target of `apps/desktop`. Read
`docs/contributing/mobile-simulator.md` before committing changes under
`apps/desktop/src-tauri/gen/apple/`, and `docs/distribution.md` for macOS builds and
TestFlight.

# Code Conventions

Favor small, composable modules, explicit contracts, tests that document behavior,
and the existing local patterns over new abstractions.

## Structured Code Style

- Keep files focused and single-responsibility. Split out helpers, hooks, and
  components when a module starts doing more than one thing.
- Use kebab-case for directories, TypeScript files, and React component files.
- Prefer `@/` imports where the project already uses them.
- Comment only non-obvious decisions or complex logic, never what the code says.
- Always write documentation for public APIs.
- Never use single-character variable names.

## TypeScript

- Prefer interfaces for object definitions. Use type aliases for unions,
  intersections, and mapped types.
- Never use `any` or `as any`. Avoid type assertions unless genuinely necessary.
- Use strict, idiomatic TypeScript with proper null handling.
- Use discriminated unions and type guards for variant data. Export helper
  predicates when they clarify a public contract.
- Use readonly fields for immutable data and generics for reusable type patterns.
- Keep shared types in `types.ts` files, or close to their consumers when local.
- Use explicit return types for public functions.
- Prefer function declarations for named functions and arrow functions for
  callbacks. Prefer async/await over Promise chains.
- A service is a class behind an interface and a factory; everything else prefers
  functions over classes.

## Data Boundaries

- Use Zod for all incoming or untrusted data: JSON, IPC payloads, external API
  responses, file-derived metadata, and worker payloads. Never parse JSON with type
  assertions.
- Normalize casing once at the boundary; TypeScript types are camelCase.
- In public function parameters or returns, use Kysely helper types
  (`Selectable<T>`, `Insertable<T>`, `Updateable<T>`), not raw table types.
- Handle Promise rejections properly, but do not add broad defensive error
  handling unless the call site needs it.

## React

- Favor named exports for components.
- One React component per file, unless a tiny private helper component is
  inseparable from its parent.
- Name props interfaces with the component name plus `Props` (`ButtonProps`).
- Do not add `use client` or `use server` directives.
- Do not `import * as React from 'react'`; import the specific React APIs.
- Never call hooks conditionally.
- Keep logic as low as possible in the tree. Prefer providers and small hooks for
  shared state.
- Move large mutation handlers, parsing, persistence, and business logic out of
  components into helpers or hooks.
- Use `zod` and `react-hook-form` for validated forms.

## UI and Styling

- Use Tailwind CSS, React, shadcn/ui components, Radix, Tailwind Aria, and
  Lucide React icons.
- Make designs responsive and give reusable React components default props.
- Always check `apps/desktop/src/components/ui/` before building custom UI.
- For overlays (popups, popovers, dropdowns, dialogs, tooltips, menus, comboboxes),
  use the shadcn component in `apps/desktop/src/components/ui/`. If it is missing
  there, install or generate it there. Never hand-roll an overlay primitive that
  shadcn covers.
