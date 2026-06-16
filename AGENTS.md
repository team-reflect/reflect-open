### Purpose

This document helps AI agents and automated systems interact with the Reflect repo safely and effectively. It summarizes setup, workflows, CI parity, testing, directories, and environment variables.

### What is Reflect

Reflect is a modern note‑taking tool with a TypeScript codebase. This repo contains Reflect V2, a rewrite of the original Reflect code-base to make it offline-first, markdown backed, and open source.

### Product Principles

Drawn from the product docs — read these for deeper context:
[V1 Overview](docs/reflect-v1-overview.md) · [V2 Product Vision](docs/reflect-v2-product-vision.md) · [V2 Grounding Brief](docs/reflect-v2-grounding-brief.md) · [Indexing Strategy](docs/reflect-v2-indexing-strategy.md) · [Sync Strategy](docs/reflect-v2-sync-strategy.md)


- **Daily notes first.** The app opens to today's note. All capture flows into the daily note by default.
- **Association over hierarchy.** `[[Wiki Links]]` replace folders. The note graph is the organizing model; there are no folders.
- **Markdown is the source of truth.** Notes are `.md` files (`daily/YYYY-MM-DD.md`, `notes/`). SQLite under `.reflect/` is a rebuildable projection of the notes — with one durable exception: the `chat_*` tables hold AI chat history, which is not derivable from markdown. Index wipes and rebuilds must leave them untouched.
- **No Reflect-hosted APIs.** LLM calls go directly to user-approved providers (OpenAI, Anthropic, etc.). Sync goes to GitHub/iCloud/Git. Never proxy through Reflect infrastructure.
- **BYOK AI.** AI features use user-supplied keys. Never assume Reflect operates AI infrastructure.
- **`private: true` is a hard block.** Notes with this frontmatter flag must never have their content sent to any external service — AI, transcription, or otherwise. Enforce at every call site.
- **Keyboard-native UX.** Every core workflow must be reachable from the keyboard. This is product identity, not polish.
- **Minimal UI.** Do less, and do it well. Don't add surfaces that compete with the editor.
- **Secrets in the OS keychain.** API keys and credentials never go in markdown, Git, or `.reflect/`.
- **Portable data.** Full export (JSON, markdown, HTML) must work from day one.
- **No Electron.** Desktop shell is Tauri.
- **MIT open-source core.** Write as if the code is public and will be critiqued.

### Development workflow

Development happens on `next` (the default branch); branch from it and target it with
PRs. `master` is the public-release branch and only advances when `next` is merged
into it for a stable release. Versions on `next` carry a prerelease suffix
(`0.2.0-beta.1`), which the release pipeline publishes as GitHub pre-releases — see
[docs/macos-distribution.md](docs/macos-distribution.md).

When a requested change is complete and verified, proactively create a PR unless
the user has asked you not to.

1. Make your changes
2. Run typecheck (`pnpm typecheck`)
3. Run lint (`pnpm lint`) — fix any errors; `pnpm lint:fix` auto-fixes where possible
4. Run specific tests for your changes (`pnpm test --run path/to/test`)

`pnpm check` runs typecheck + lint together. Run it before declaring any work done.

### Running tests

There are too many tests for you to run them all, so you will just have to run the ones that are specific to whatever logic you've written.

Local unit tests:

```bash
# Run vitest tests
pnpm test --run path/to/test
```

Rust tests (the Cargo workspace: desktop shell, `reflect` CLI, index-schema crate):

```bash
# Prefer per-crate runs; cargo test --workspace also works
cargo test -p reflect-cli
cargo test -p reflect-open
```

**Before any cargo build/check/test that compiles the desktop crate** (including
`--workspace` commands and clippy), the sidecars (the `reflect` CLI and the
`reflect-capture-host` native-messaging host) must be staged once per checkout:

```bash
pnpm --filter @reflect/desktop sidecar
```

Otherwise tauri-build fails with `resource path binaries/<name>-<triple> doesn't exist`
(`pnpm tauri dev`/`build` stage them automatically; details in [docs/cli.md](docs/cli.md)).

### Repo layout

Reflect is a **Turborepo + pnpm monorepo** around a **Tauri 2** desktop/mobile app: a
React + TypeScript frontend bundled by Vite, embedded in a Rust native shell. The Rust
crates form a single **Cargo workspace** rooted at the repository root.

```
reflect-open/
├── apps/
│   ├── desktop/            # @reflect/desktop — the Tauri 2 app
│   │   ├── src/            # React frontend (main.tsx, app.tsx, components/, editor/,
│   │   │                   #   hooks/, providers/, routing/); calls Rust via @tauri-apps/api
│   │   ├── src-tauri/      # Tauri native shell (Rust crate `reflect-open`)
│   │   │   ├── src/        # lib.rs (#[tauri::command] handlers, plugins), db/, fs/,
│   │   │   │               #   watcher.rs, embed.rs, recents.rs, secrets.rs, settings.rs
│   │   │   ├── tauri.conf.json          # build hooks, windows, bundle targets (incl. iOS)
│   │   │   ├── tauri.<platform>.conf.json  # desktop overlays: bundle the reflect CLI sidecar
│   │   │   ├── capabilities/            # Tauri 2 permission grants (e.g. default.json)
│   │   │   ├── icons/                   # App icons for desktop/mobile bundles
│   │   │   ├── gen/                     # Generated schemas + platform projects (no hand-edits)
│   │   │   └── ios.project.yml          # iOS XcodeGen template
│   │   ├── scripts/        # build-sidecar.mjs (stages the reflect CLI for bundling)
│   │   ├── dist/           # Vite build output (frontendDist in tauri.conf.json)
│   │   └── public/         # Static assets served by Vite
│   ├── cli/                # `reflect` — self-contained Rust read/discovery CLI (see docs/cli.md)
│   ├── extension/          # @reflect/extension — Chrome MV3 capture extension (WXT; see its README)
│   └── native-host/        # `reflect-capture-host` — native-messaging spooler sidecar (Plan 11)
├── packages/
│   ├── core/               # @reflect/core — ALL TS business logic (markdown/, indexing/,
│   │                       #   graph/, embeddings/, ai/, settings/, ipc/)
│   └── db/                 # @reflect/db — generated Kysely schema + the IPC dialect
├── crates/
│   └── index-schema/       # Shared SQLite migrations for <graph>/.reflect/index.sqlite
│                           #   (one schema for the desktop writer + CLI reader)
├── design-system/          # Design tokens, components, and UI guidelines (see design-system/readme.md)
├── docs/                   # Product/architecture docs + docs/plans/ (Reflect V2)
├── Cargo.toml              # Root Cargo workspace (reflect-open, reflect-cli, reflect-capture-host, reflect-index-schema)
└── turbo.json, pnpm-workspace.yaml
```

**Design system**

All UI work should follow the Reflect design system documented in [`design-system/readme.md`](design-system/readme.md). Key resources:

- `design-system/tokens/` — CSS custom properties for color, typography, spacing, and motion
- `design-system/components/` — reusable React primitives (Button, Input, Badge, etc.)
- `design-system/guidelines/` — color, type, spacing, and brand specimens
- `design-system/styles.css` — global entry point that imports all tokens

**Frontend ↔ Rust bridge**

- Define commands in `apps/desktop/src-tauri/src/` (registered in `lib.rs`'s `invoke_handler`) with `#[tauri::command]`.
- Call commands from the frontend with `invoke` from `@tauri-apps/api/core`.
- Add Tauri plugins in `apps/desktop/src-tauri/Cargo.toml` (Rust) and grant permissions in `apps/desktop/src-tauri/capabilities/`.

**Common commands** (run from the repo root)

```bash
pnpm dev              # turbo dev across packages (Vite on http://localhost:1420)
pnpm tauri dev        # Full Tauri app with hot reload (stages the CLI sidecar first)
pnpm build            # turbo build pipeline → apps/desktop/dist/
pnpm tauri build      # Native app bundle, incl. the reflect CLI sidecar
pnpm release:bump     # Bump the version everywhere + push the release tag (docs/macos-distribution.md)
pnpm release:macos    # Signed + notarized macOS build for distribution (docs/macos-distribution.md)
pnpm release:macos publish  # The above, then upload the DMG to a new GitHub release
```

# Code Conventions

When writing or modifying code in this project, please adhere to the following conventions:

1.  **TypeScript Best Practices**: Follow standard, idiomatic TypeScript coding practices for structure, naming, and types, unless otherwise overridden.
2.  **Minimal Comments**: Avoid adding comments unless they explain complex logic or non-obvious decisions. Well-written, self-explanatory code is preferred. Do not add comments that merely restate what the code does.
3.  **Tests as Documentation**: Rely on comprehensive tests (which will be added later if not present) to document the behavior and usage of the code, rather than extensive comments within the code itself.
4.  **File naming conventions**: Use kebab-case when naming directories, TypeScript, and other files.
5.  **Type checking**: after major modifications run `pnpm typecheck` and fix any errors.
6.  **UX/UI** We are using Tailwind CSS, React, shadcn/ui components and Lucide React icons. Generate responsive designs. Provide default props for React Components. **Always check `apps/desktop/src/components/ui/` first before building any custom UI.** For any popup, popover, dropdown, dialog, tooltip, menu, or overlay — use the existing shadcn component from that directory. Never build a custom implementation when a shadcn primitive already exists.
7.  **Models/db/tables** When pulling in a database type, Kysely.
8.  **Open-source conventions** Pretend you are writing code for a open-source project. Write best-in-class code.

# Style

- Conventions: small files, single-responsibility, testable interfaces, providers+hooks for state, one component per file, '@/' imports, zod for parsing/validation, no any.
- Pretend you are going to open source the code, so write extremely high quality code that's documented - you don't want to be embarrassed when it's critiqued by other engineers.

Do this:

- Keep modules small and composable.
- Add zod schemas for all incoming data; normalize to camelCase once in a bridge layer.
- Use discriminated unions and type guards; export helper predicates (e.g., isTerminalEvent).

Non-negotiables:

- No any. Use zod for runtime validation.
- Normalize casing at boundaries; TS types are camelCase.
- Small, testable modules; clear public APIs.
- Don’t call hooks conditionally.
- Prefer to split out logic into smaller files.
- Never use `any` or `as any` in Typescript.
- Never use single character variable names.
- Always write documentation for all public APIs.
- Always run build/typecheck/lint before declaring done.

# TypeScript Best Practices

## Type System

- Prefer interfaces over types for object definitions
- Use type for unions, intersections, and mapped types
- NEVER use `any` or `as any` types or coercion
- Use strict TypeScript configuration
- Leverage TypeScript's built-in utility types
- Use generics for reusable type patterns
- Always use Zod for parsing JSON. It's installed.

## Naming Conventions

- Use PascalCase for type names and interfaces
- Use camelCase for variables and functions
- Use UPPER_CASE for constants
- Use descriptive names with auxiliary verbs (e.g., isLoading, hasError)
- Prefix interfaces for React props with 'Props' (e.g., ButtonProps)

## Code Organization

- Keep type definitions close to where they're used
- Export types and interfaces from dedicated type files when shared
- Use barrel exports (index.ts) for organizing exports
- Place shared types in a `types.ts` file
- Co-locate component props with their components

## Functions

- Use explicit return types for public functions
- Use arrow functions for callbacks and methods
- Implement proper error handling with custom error types
- Use function overloads for complex type scenarios
- Prefer async/await over Promises
- Prefer function declarations over function expressions.
- Prefer functional programming over classes.

## Best Practices

- Enable strict mode in tsconfig.json
- Use readonly for immutable properties
- Leverage discriminated unions for type safety
- Use type guards for runtime type checking
- Implement proper null checking
- Avoid type assertions unless necessary

## Error Handling

- Do not proactively add error handling
- Handle Promise rejections properly

# React Naming Conventions:

- Use kebab-case for files and directories.

# React Components

- DO not use 'use client' or 'use server' statements
- Favor named exports for components
- Ensure components are modular, reusable, and maintain a clear separation of concerns.
- Always split React components out so there is only ever one per file
- Keep logic as low as possible. For example a PostItem should handling its own deletion, rather than passing the logic up in a property callback.
- Rather than have a large function, like a TRPC mutation handler, inside the component, refactor and split it out into a generic helper or hooks lib.
- Prefer the hooks pattern for complex logic, or the mobx view model pattern. Look at existing examples in the project.
- DO NOT `import * as React from 'react'`, import each React function specifically
- `zod` and `react-hook-form` packages are installed - use them.
- In React, create a provider and a small hook for state; avoid conditional hooks.

# React UI and Styling

- Use Shadcn UI, Radix, and Tailwind Aria for components and styling
- **Always use the shadcn component from `apps/desktop/src/components/ui/` for any interactive or overlay UI** — dropdown menus, popovers, dialogs, tooltips, comboboxes, etc. Never hand-roll these.
- Implement responsive design with Tailwind CSS to cater for smaller screens.
