# Reflect

**Daily notes, linked thinking, and an AI that answers from your own notes.
All in plain files on your Mac.**

[![Release](https://img.shields.io/github/v/release/team-reflect/reflect-open)](https://github.com/team-reflect/reflect-open/releases/latest)
[![CI](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml/badge.svg)](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reflect opens to today's note. Write your day (meetings, ideas, journal) and
type `[[` to link the people and projects in it. Those links grow into a
personal graph of everything you've written, and search and AI sit on top of
it, so "what did we decide about this last spring?" is one search (`⌘K`) or
one question (`⌘J`) away.

It's built on a single promise: **your notes stay yours.** They are ordinary
text files in a folder you choose. There's no account, no cloud database, and
no telemetry; nothing leaves your Mac except through services you explicitly
connect. If Reflect disappeared tomorrow, your notes would still open in any
text editor.

## Highlights

- **Today, first.** The app opens to today's note. Capture everything there
  and let links, not folders, organize it.
- **Links that build a graph.** Type `[[` to connect notes; every note shows
  what links back to it. Rename a note and its links follow.
- **Search that gets meaning (`⌘K`).** Instant search over every note, plus
  optional semantic search that finds "that pasta thing" even if you never
  wrote "pasta". Both run entirely on your Mac.
- **Ask your notes (`⌘J`).** Connect your own OpenAI, Anthropic, or Google
  account; Reflect talks straight to the provider, with no middleman server.
  Answers cite the notes they came from, as clickable links.
- **A private flag that means it.** Mark a note `private: true` and its
  content can never be sent to any AI or online service. That rule is
  enforced in code and covered by tests.
- **Talk instead of type.** Record an audio memo; it's saved instantly and
  transcribed into your daily note with your own key.
- **Free backup, full history.** Connect GitHub in-app (or
  [any git host you run](docs/generic-git-remotes.md)) and every change is
  versioned in a repository you own. Conflicts show up as plain choices
  instead of merge jargon.
- **Keyboard-native and light.** Every core action has a shortcut (`⌘/` shows
  them all). The app itself is Tauri rather than Electron: native, signed,
  notarized, and auto-updating.
- **Scriptable.** A real CLI (`reflect today`, `reflect search`,
  `reflect show`) for scripts and agents; see [docs/cli.md](docs/cli.md).

## Install

Download the latest DMG from
[**Releases**](https://github.com/team-reflect/reflect-open/releases/latest)
(macOS, Apple Silicon). The app is Developer-ID signed and notarized, and
updates itself from GitHub Releases; update payloads are verified against a
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
└── .reflect/               # SQLite index (rebuildable, git-ignored)
```

Markdown is the source of truth. Everything derived from it (search index,
backlinks, tags, embeddings) lives in `.reflect/index.sqlite` and is rebuilt
from the files on demand; deleting it loses nothing. Frontmatter stays
minimal: a stable `id`, optional `aliases`, and the `private` / `pinned`
flags. Edit your notes with any other tool while Reflect runs; the file
watcher picks up external changes and re-indexes.

## Privacy model

Every network call the app can make is documented in
[**What leaves the device, and when**](docs/privacy.md): what each one
carries, where it goes, and what's off by default. The short version:
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
dependency-ordered design documents in [docs/plans/](docs/plans/).
[00-overview.md](docs/plans/00-overview.md) is the roadmap and records what
shipped in each release;
[architecture-conventions.md](docs/plans/architecture-conventions.md) holds
the cross-cutting decisions every plan assumes. A comment like "Plan 02"
points at the design rationale for that subsystem.

## Development

```bash
pnpm dev              # Vite only (http://localhost:1420, no native shell)
pnpm typecheck        # all packages (tsc)
pnpm test             # all packages (vitest); --run path/to/test for one file
pnpm lint             # oxlint

# Rust: stage the CLI sidecar once per checkout first, or tauri-build fails
pnpm --filter @reflect/desktop sidecar
cargo test --workspace
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, the step-by-step
guides in [docs/contributing/](docs/contributing/) (adding a command, adding a
setting, editor architecture), and [AGENTS.md](AGENTS.md) for the full
contributor guide.

## Status & roadmap

Reflect is early (`0.2.x` beta) but used daily. Shipped today: everything
listed above, plus browser link capture through the Chrome extension/native
host pipeline described in [Plan 11](docs/plans/11-link-capture.md).

Closed by decision:

- **Import / export surfaces**
  ([Plan 13](docs/plans/13-import-export-portability.md)): no dedicated
  import/export suite is planned. The graph folder itself is the portable
  artifact; copy or zip the markdown files and assets directly. Reflect V1
  exports now use the same graph-compatible markdown shape.

Designed or in progress, each with a written plan:

- **Tasks** ([Plan 18](docs/plans/18-tasks.md)): checkboxes in your notes,
  collected into one Tasks view.
- **Mobile companion** ([Plan 19](docs/plans/19-mobile.md)): iOS is in
  progress in the Tauri app, with Daily/All surfaces and editing foundations
  landed; device validation, sync hardening, and TestFlight/App Store release
  remain.

Windows, Android, and a plugin API are out of scope for now; the
[product vision](docs/reflect-v2-product-vision.md) explains the long-term
direction and what is deliberately *not* planned.

## License

[MIT](LICENSE), including the editor and every bundled dependency.
