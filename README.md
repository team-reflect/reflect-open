# Reflect

Reflect is a local-first, markdown-native note-taking app. Notes are plain
`.md` files on your disk — daily notes in `daily/`, everything else in
`notes/` — connected by `[[wiki links]]` instead of folders. Everything
derived from them (search, backlinks, tags) lives in a rebuildable SQLite
index; deleting it loses nothing.

This repository is **Reflect V2**: an offline-first, open-source rewrite. See
the [product vision](docs/reflect-v2-product-vision.md) for the full picture.

## Principles

- **Markdown is the source of truth.** SQLite under `.reflect/` is a
  projection, never durable storage. Full export works from day one.
- **Daily notes first, association over hierarchy.** The app opens to today;
  wiki links and backlinks are the organizing model. No folders.
- **No Reflect-hosted APIs.** AI features are bring-your-own-key and talk
  directly to the provider; sync goes to GitHub. Notes marked `private: true`
  are never sent to any external service.
- **Keyboard-native, minimal UI.** Built on Tauri 2 — no Electron.

## Architecture

A pnpm/Turborepo monorepo with one load-bearing rule: **TypeScript owns policy,
Rust owns capabilities.**

```text
reflect-open/
├── apps/desktop/          # The Tauri app
│   ├── src/               # React UI: providers, components, the editor
│   └── src-tauri/         # Rust shell: file IO, SQLite, file watching, recents
├── packages/core/         # All business logic (platform-agnostic TypeScript)
├── packages/db/           # Kysely schema + the query-builder dialect
├── design-system/         # Tokens + UI primitives
└── docs/plans/            # The numbered implementation plans (see below)
```

Data flows in one loop: the editor writes a markdown file (atomic write in
Rust) → the file watcher reports the change → `@reflect/core` re-parses the
note and applies its projection to SQLite → queries (search, backlinks) read
the projection via Kysely. Our own saves take the same path as external edits,
so the index can never disagree with the files.

`@reflect/core` never imports Tauri. It talks to the native shell through an
injected bridge (`setBridge`), which is what keeps it testable in plain vitest
and reusable by the planned CLI. The desktop app installs the Tauri adapter at
startup ([apps/desktop/src/lib/tauri-bridge.ts](apps/desktop/src/lib/tauri-bridge.ts)).

## Development

```bash
pnpm install
pnpm tauri dev        # full app with hot reload
pnpm dev              # Vite only (http://localhost:1420, no native shell)

pnpm typecheck        # all packages (tsc)
pnpm test             # all packages (vitest); pass --run path/to/test for one file
pnpm lint             # oxlint
cd apps/desktop/src-tauri && cargo test   # Rust suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and
[AGENTS.md](AGENTS.md) for the full contributor/agent guide.

## The plans

Code and comments reference numbered plans (e.g. "Plan 04b"). These are the
dependency-ordered implementation phases in [docs/plans/](docs/plans/) —
[00-overview.md](docs/plans/00-overview.md) is the roadmap, and
[architecture-conventions.md](docs/plans/architecture-conventions.md) holds the
cross-cutting decisions every plan assumes. A comment like "Plan 02" points at
the design rationale for that subsystem.
