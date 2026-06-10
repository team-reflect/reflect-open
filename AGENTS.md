### Purpose

This document helps AI agents and automated systems interact with the Reflect repo safely and effectively. It summarizes setup, workflows, CI parity, testing, directories, and environment variables.

### What is Reflect

Reflect is a modern note‑taking tool with a TypeScript codebase. This repo contains Reflect V2, a rewrite of the original Reflect code-base to make it offline-first, markdown backed, and open source.

### Product Principles

Drawn from the product docs — read these for deeper context:
[V1 Overview](docs/reflect-v1-overview.md) · [V2 Product Vision](docs/reflect-v2-product-vision.md) · [V2 Grounding Brief](docs/reflect-v2-grounding-brief.md) · [Indexing Strategy](docs/reflect-v2-indexing-strategy.md) · [Sync Strategy](docs/reflect-v2-sync-strategy.md)


- **Daily notes first.** The app opens to today's note. All capture flows into the daily note by default.
- **Association over hierarchy.** `[[Wiki Links]]` replace folders. The note graph is the organizing model; there are no folders.
- **Markdown is the source of truth.** Notes are `.md` files (`daily/YYYY-MM-DD.md`, `notes/`). SQLite under `.reflect/` is a rebuildable projection, never durable storage.
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

### Repo layout

Reflect is a **Tauri 2** desktop/mobile app: a React + TypeScript frontend bundled by Vite, embedded in a Rust native shell.

```
reflect-open/
├── src/                    # Frontend (React + TypeScript)
│   ├── main.tsx            # React entry point
│   └── App.tsx             # Root component; calls Rust via @tauri-apps/api
├── src-tauri/              # Tauri native shell (Rust)
│   ├── src/
│   │   ├── lib.rs          # App setup, #[tauri::command] handlers, plugins
│   │   └── main.rs         # Desktop entry point (calls lib::run)
│   ├── tauri.conf.json     # Tauri config: build hooks, windows, bundle targets (incl. iOS)
│   ├── Cargo.toml          # Rust crate + Tauri plugin dependencies
│   ├── capabilities/       # Tauri 2 permission grants (e.g. default.json)
│   ├── icons/              # App icons for desktop/mobile bundles
│   ├── gen/                # Generated schemas + platform projects (do not hand-edit)
│   └── ios.project.yml     # iOS XcodeGen template
├── dist/                   # Vite build output (frontendDist in tauri.conf.json)
├── public/                 # Static assets served by Vite
├── docs/                   # Product/architecture docs (Reflect V2)
└── design-system/          # Design tokens, components, and UI guidelines (see design-system/readme.md)
```

**Design system**

All UI work should follow the Reflect design system documented in [`design-system/readme.md`](design-system/readme.md). Key resources:

- `design-system/tokens/` — CSS custom properties for color, typography, spacing, and motion
- `design-system/components/` — reusable React primitives (Button, Input, Badge, etc.)
- `design-system/guidelines/` — color, type, spacing, and brand specimens
- `design-system/styles.css` — global entry point that imports all tokens

**Frontend ↔ Rust bridge**

- Define commands in `src-tauri/src/lib.rs` with `#[tauri::command]` and register them in `invoke_handler`.
- Call commands from the frontend with `invoke` from `@tauri-apps/api/core`.
- Add Tauri plugins in `Cargo.toml` (Rust) and grant permissions in `src-tauri/capabilities/`.

**Common commands**

```bash
pnpm dev              # Vite dev server only (http://localhost:1420)
pnpm tauri dev        # Full Tauri app with hot reload
pnpm build            # Typecheck + Vite production build → dist/
pnpm tauri build      # Build native app bundle (desktop and/or mobile targets)
```

# Code Conventions

When writing or modifying code in this project, please adhere to the following conventions:

1.  **TypeScript Best Practices**: Follow standard, idiomatic TypeScript coding practices for structure, naming, and types, unless otherwise overridden.
2.  **Minimal Comments**: Avoid adding comments unless they explain complex logic or non-obvious decisions. Well-written, self-explanatory code is preferred. Do not add comments that merely restate what the code does.
3.  **Tests as Documentation**: Rely on comprehensive tests (which will be added later if not present) to document the behavior and usage of the code, rather than extensive comments within the code itself.
4.  **File naming conventions**: Use kebab-case when naming directories, TypeScript, and other files.
5.  **Type checking**: after major modifications run `pnpm typecheck` and fix any errors.
6.  **UX/UI** We are using Tailwind CSS, React, shadcn/ui components and Lucide React icons. Generate responsive designs. Provide default props for React Components. Check to see if a shadcn component exists under `components/ui` before installing it.
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
- Prefer using Shadcn components for anything UI related
- Implement responsive design with Tailwind CSS to cater for smaller screens.
