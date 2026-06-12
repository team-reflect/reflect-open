# Reflect

**A local-first, markdown-native, AI-native notes app for macOS.**

[![Release](https://img.shields.io/github/v/release/team-reflect/reflect-open)](https://github.com/team-reflect/reflect-open/releases/latest)
[![CI](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml/badge.svg)](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Your notes are plain `.md` files in a folder you choose. Reflect gives them a
fast keyboard-native editor, a knowledge graph built from `[[wiki links]]`,
local full-text *and* semantic search, an AI chat that reads your notes with
your own API key — and never runs a server. There is no account, no telemetry,
and no Reflect-hosted API in any code path.

- **Daily notes first.** The app opens to today (`⌘D`). Capture goes there by
  default; structure emerges from links, not folders.
- **`[[Wiki links]]` & backlinks.** Autocomplete on `[[`, create-on-link,
  incoming backlinks under every note. Renames rewrite inbound links and keep
  the old title as an alias.
- **Search (`⌘K`).** SQLite FTS5 with filters (`#tag`, `is:daily`, `links:`,
  `linked-from:`, `updated:>2026-01-01`), plus semantic search powered by
  on-device embeddings — note content never leaves the machine to be indexed.
- **AI chat (`⌘J`), bring-your-own-key.** OpenAI, Anthropic, or Google — your
  key, stored in the macOS keychain, calls made directly to the provider.
  The model reads your graph through search/read tools with citations.
- **`private: true` is a hard block.** Flag a note and its content can never
  be sent to any external service — enforced in the type system at every AI
  call site, re-checked from disk at call time, covered by tests.
- **Audio memos.** Record into today's note; the recording is saved locally
  first and transcribed asynchronously with your own provider key.
- **Backup & sync via git.** Connect GitHub in-app (private repo by default)
  or [any git host over SSH](docs/generic-git-remotes.md). Conflicts surface
  as plain-language review, never raw merge mechanics.
- **A real CLI.** `reflect today`, `reflect search`, `reflect show` — script
  your notes, pipe them to agents ([docs/cli.md](docs/cli.md)).
- **Native, not Electron.** Tauri 2: a React frontend in a Rust shell. Signed,
  notarized, auto-updating.

## Install

Download the latest DMG from
[**Releases**](https://github.com/team-reflect/reflect-open/releases/latest)
(macOS, Apple Silicon). The app is Developer-ID signed and notarized, and
updates itself from GitHub Releases — update payloads are verified against a
public key compiled into the app.

Or [build from source](#building-from-source).

## Your notes are just files

Reflect calls a notes folder a **graph**. Point it at any folder and it
scaffolds:

```text
my-graph/
├── daily/2026-06-12.md     # daily notes, named by date
├── notes/some-title.md     # everything else, readable title-derived names
├── assets/                 # images and attachments, relative-linked
├── audio-memos/            # recordings awaiting/after transcription
└── .reflect/               # SQLite index — rebuildable, git-ignored
```

Markdown is the source of truth. Everything derived from it — search index,
backlinks, tags, embeddings — lives in `.reflect/index.sqlite` and is rebuilt
from the files on demand; deleting it loses nothing. Frontmatter stays
minimal: a stable `id`, optional `aliases`, and the `private` / `pinned`
flags. Edit your notes with any other tool while Reflect runs — the file
watcher picks up external changes and re-indexes.

## Privacy model

Every network call the app can make — what it carries, where it goes, and
what's off by default — is documented in
[**What leaves the device, and when**](docs/privacy.md). The short version:
nothing leaves your machine unless you add a provider key or connect a git
remote, and `private: true` notes are excluded from anything that reads
content. Secrets live in the OS keychain only.

## Building from source

Prerequisites: a recent stable [Rust toolchain](https://rustup.rs), Node.js
with [pnpm](https://pnpm.io) 10 (`corepack enable` uses the pinned version),
and the Xcode Command Line Tools.

```bash
git clone https://github.com/team-reflect/reflect-open.git
cd reflect-open
pnpm install
pnpm tauri dev      # run the full app with hot reload
pnpm tauri build    # produce a native bundle
```

## Architecture

A pnpm/Turborepo monorepo with one load-bearing rule: **TypeScript owns
policy, Rust owns capabilities.**

```text
reflect-open/
├── apps/desktop/          # The Tauri app
│   ├── src/               # React UI: providers, components, the editor
│   └── src-tauri/         # Rust shell: file IO, SQLite, watching, git, embeddings
├── apps/cli/              # The `reflect` CLI (Rust, bundled as a sidecar)
├── packages/core/         # All business logic (platform-agnostic TypeScript)
├── packages/db/           # Kysely schema + the query-builder dialect
├── crates/index-schema/   # SQLite migrations shared by app and CLI
├── design-system/         # Tokens + UI primitives
└── docs/plans/            # The numbered implementation plans (see below)
```

Data flows in one loop: the editor writes a markdown file (atomic write in
Rust) → the file watcher reports the change → `@reflect/core` re-parses the
note and applies its projection to SQLite → queries (search, backlinks) read
the projection via Kysely. Reflect's own saves take the same path as external
edits, so the index can never disagree with the files.

`@reflect/core` never imports Tauri. It talks to the native shell through an
injected bridge (`setBridge`), which keeps it testable in plain vitest. The
desktop app installs the Tauri adapter at startup
([apps/desktop/src/lib/tauri-bridge.ts](apps/desktop/src/lib/tauri-bridge.ts)).

The editor is [meowdown](https://github.com/prosekit/meowdown) (MIT):
ProseMirror over a Lezer markdown parse, rendering markdown in place while
round-tripping it byte-faithfully. Notes the editor cannot round-trip open
read-only rather than ever being silently rewritten.

### The plans

Code and comments reference numbered plans (e.g. "Plan 04b"). These are the
dependency-ordered design documents in [docs/plans/](docs/plans/) —
[00-overview.md](docs/plans/00-overview.md) is the roadmap and records what
shipped in each release, and
[architecture-conventions.md](docs/plans/architecture-conventions.md) holds
the cross-cutting decisions every plan assumes. A comment like "Plan 02"
points at the design rationale for that subsystem.

## Development

```bash
pnpm dev              # Vite only (http://localhost:1420, no native shell)
pnpm typecheck        # all packages (tsc)
pnpm test             # all packages (vitest); --run path/to/test for one file
pnpm lint             # oxlint

# Rust — stage the CLI sidecar once per checkout first, or tauri-build fails:
pnpm --filter @reflect/desktop sidecar
cargo test --workspace
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, the step-by-step
guides in [docs/contributing/](docs/contributing/) (adding a command, adding a
setting, editor architecture), and [AGENTS.md](AGENTS.md) for the full
contributor guide.

## Status & roadmap

Reflect is early (`0.1.x`) but used daily. Shipped today: everything listed
above. Designed but not yet built — each has a written plan:

- **Browser link capture** ([Plan 11](docs/plans/11-link-capture.md)) — Chrome
  extension → local native-messaging bridge → daily note.
- **Import / export surfaces** ([Plan 13](docs/plans/13-import-export-portability.md)) —
  the graph is already portable markdown you can copy wholesale; the in-app
  Obsidian import and Markdown/JSON/HTML export are still to come.
- **Tasks** ([Plan 18](docs/plans/18-tasks.md)) — GFM checkboxes aggregated
  into a Tasks view, as a pure projection.

Windows, mobile, and a plugin API are out of scope for now; the
[product vision](docs/reflect-v2-product-vision.md) explains the long-term
direction and what is deliberately *not* planned.

## License

[MIT](LICENSE) — including the editor and every bundled dependency.
