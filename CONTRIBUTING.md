# Contributing to Reflect

Thanks for helping build Reflect. This is the short version; the full
contributor/agent guide lives in [AGENTS.md](AGENTS.md), and the architecture
decisions in
[docs/plans/architecture-conventions.md](docs/plans/architecture-conventions.md).

## Setup

```bash
pnpm install
pnpm tauri dev    # full desktop app (requires the Rust toolchain)
pnpm dev          # frontend only, no native shell
```

## Before you open a PR

```bash
pnpm typecheck
pnpm test --run <paths you touched>
pnpm lint
cargo test        # from apps/desktop/src-tauri, if you touched Rust
```

## Where code goes

- **Business logic → `packages/core`.** No file/DB/AI logic in React
  components, hooks, or Tauri command handlers. Components call typed
  `@reflect/core` bindings; Rust commands are thin wrappers over native
  primitives.
- **Rust owns capabilities, TypeScript owns policy.** A Rust command never
  encodes a product rule beyond the primitive it exposes (e.g. the watcher
  emits events; *what* to reindex is decided in core).
- **`@reflect/core` and `@reflect/db` never import Tauri.** Native access goes
  through the injected bridge (`setBridge`); tests install fakes instead of
  module mocks.

## Conventions that are checked in review

- TypeScript: strict, no `any` (ever), zod at external boundaries,
  kebab-case filenames, one React component per file, named exports,
  explicit return types on public functions.
- Keep modules small and single-responsibility; extract logic from components
  into hooks or pure modules so it's testable without rendering.
- Document every public API with a doc comment that explains *why*, not what.
  Comments that restate the code get dropped in review.
- Tests are the behavioral documentation: cover the invariants of anything you
  add, colocated as `*.test.ts(x)` (TS) or `#[cfg(test)]` (Rust).

## Hard product rules

- Notes with `private: true` frontmatter must never reach an external service.
  Enforce at every call site.
- Markdown files are the source of truth; SQLite under `.reflect/` is a
  rebuildable cache. Never make the index durable.
- No Reflect-hosted APIs, no Electron, secrets only in the OS keychain.

## Guides

Step-by-step walkthroughs for the most common kinds of change:

- [Adding a native command](docs/contributing/adding-a-command.md) — the full
  Rust → bridge → zod → React path, with conventions and a checklist.
- [Adding a user setting](docs/contributing/adding-a-setting.md) — schema key,
  defaults-by-construction, the settings screen. (No Rust involved.)
- [Editor architecture](docs/contributing/editor-architecture.md) — the
  session/adapter split, the save loop, and where new editor code goes.

## "Plan NN" in comments?

Numbered plans in [docs/plans/](docs/plans/) are the implementation roadmap;
a comment citing "Plan 04b" points at that plan's design rationale. Start with
[docs/plans/00-overview.md](docs/plans/00-overview.md).
