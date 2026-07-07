# Reflect

Plain-file notes for Mac and iPhone: daily notes, wiki links, local search,
and optional AI over your own Markdown.

[![Release](https://img.shields.io/github/v/release/team-reflect/reflect-open)](https://github.com/team-reflect/reflect-open/releases/latest)
[![CI](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml/badge.svg)](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reflect is an open-source note-taking app built around a folder of Markdown
files. It opens to today's note, lets `[[wiki links]]` connect people,
projects, and ideas, and builds a local index for search, backlinks, and graph
queries.

The app does not require a Reflect account or hosted Reflect API. Notes live in
a folder you choose. Optional services such as LLM providers, transcription,
iCloud, GitHub, or another git remote are connected directly by the user.

<img width="2926" height="1800" alt="Reflect" src="https://github.com/user-attachments/assets/6da0e0d2-3f25-4fc4-850c-b764548c3abe" />

## Features

- **Daily notes:** the app opens to today's note, and capture defaults there.
- **Wiki links and backlinks:** type `[[` to link notes; each note shows what
  links back to it.
- **Local search:** `⌘K` searches notes, backlinks, tags, and the local index.
  Optional semantic search uses local embeddings.
- **Ask your notes:** `⌘J` can query notes through user-provided OpenAI,
  Anthropic, Google, or OpenRouter keys. Answers cite source notes.
- **Private notes:** `private: true` excludes a note's content from AI and
  other external services.
- **Audio memos:** record audio and transcribe it into the daily note with a
  configured transcription provider.
- **Browser capture:** save links, selected text, screenshots, and page text
  from Chrome through the local native-messaging host.
- **Sync choices:** use iCloud Drive for file sync, or git/GitHub for
  versioned backup.
- **CLI:** `reflect today`, `reflect search`, and `reflect show` are available
  for scripts and agents. See [docs/cli.md](docs/cli.md).

## Install

Download the latest macOS DMG from
[Releases](https://github.com/team-reflect/reflect-open/releases/latest).
The macOS app is signed, notarized, and auto-updated from GitHub Releases.

Reflect for iPhone is available through
[TestFlight](https://testflight.apple.com/join/j2eEz43d). The iOS app uses the
same plain-file graph and sync options as the Mac app.

You can also [build from source](#building-from-source).

## Browser Capture

Install
[Reflect Capture from the Chrome Web Store](https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd)
to capture the current page into Reflect from Chrome.

The extension sends captures to the installed Mac app through a local
native-messaging host. If Reflect is closed, the host queues captures in the
graph's local `.reflect/inbox/` folder, and the app imports them on the next
launch.

## Data Model

Reflect calls a notes folder a **graph**. A new graph looks like this:

```text
my-graph/
├── daily/2026-06-12.md     # Daily notes, named by date
├── notes/some-title.md     # Other notes, named from their titles
├── assets/                 # Images and attachments
├── audio-memos/            # Audio recordings and transcripts
└── .reflect/               # Local SQLite index, git-ignored
```

Markdown files are the source of truth. Search data, backlinks, tags,
embeddings, and other derived data live in `.reflect/index.sqlite` and can be
rebuilt from the Markdown files.

Frontmatter is intentionally small: a stable `id`, optional `aliases`, and the
`private` / `pinned` flags. External edits are picked up by the file watcher and
re-indexed.

## Sync and Privacy

For simple file sync across Apple devices, create your graph inside an
iCloud-synced folder such as `iCloud Drive/ReflectGraph`.

For versioned backup or non-iCloud sync, connect GitHub in the app or add
[any SSH git remote](docs/generic-git-remotes.md) as the graph's `origin`.
Git sync stores the Markdown graph in a repository you control and leaves the
rebuildable `.reflect/` index out of the backup.

Every network call is documented in
[docs/privacy.md](docs/privacy.md). By default, note content stays on the
device. External calls only happen after you configure a provider, connect a git
remote, or use a platform sync service. Secrets are stored in the OS keychain.

iCloud Drive encryption depends on the user's iCloud settings. Apple's
[Advanced Data Protection](https://support.apple.com/en-us/108756) enables
end-to-end encryption for iCloud Drive content, with some Apple service
metadata outside that protection.

## Building from Source

Prerequisites:

- A recent stable [Rust toolchain](https://rustup.rs)
- Node.js with [pnpm](https://pnpm.io) 10
- Xcode Command Line Tools

```bash
git clone https://github.com/team-reflect/reflect-open.git
cd reflect-open
corepack enable
pnpm install
pnpm tauri dev
pnpm tauri build
```

## Architecture

Reflect is a pnpm/Turborepo monorepo with a React + TypeScript frontend and a
Tauri 2 native shell.

```text
reflect-open/
├── apps/desktop/          # Tauri app
│   ├── src/               # React UI, providers, components, editor
│   └── src-tauri/         # Rust shell: file IO, SQLite, git, embeddings
├── apps/cli/              # `reflect` CLI, bundled as a sidecar
├── apps/extension/        # Chrome capture extension
├── apps/native-host/      # Native-messaging capture host
├── packages/core/         # Platform-agnostic TypeScript business logic
├── packages/db/           # Kysely schema and IPC dialect
├── crates/index-schema/   # Shared SQLite migrations
├── design-system/         # Tokens and UI primitives
└── docs/                  # Product, architecture, and implementation docs
```

The editor writes Markdown through the Rust shell. The file watcher reports
changes, `@reflect/core` parses the note, and the SQLite projection is updated
for search and backlinks. Saves made by Reflect and edits made by other tools
use the same indexing path.

`@reflect/core` does not import Tauri. Platform capabilities are provided
through an injected bridge, installed by the desktop app at startup in
[apps/desktop/src/lib/tauri-bridge.ts](apps/desktop/src/lib/tauri-bridge.ts).

The editor is [meowdown](https://github.com/prosekit/meowdown), a
ProseMirror/Lezer Markdown editor that renders Markdown in place while
preserving round trips. Notes that cannot be round-tripped safely open
read-only.

## Development

Common commands from the repository root:

```bash
pnpm dev              # Vite only, http://localhost:1420
pnpm typecheck        # TypeScript
pnpm lint             # oxlint
pnpm test             # vitest; use --run path/to/test for one file
pnpm check            # typecheck + lint

# Rust tests that compile the desktop crate need sidecars staged first
pnpm --filter @reflect/desktop sidecar
cargo test --workspace
```

For iOS simulator development:

```bash
pnpm tauri ios dev "iPhone 17 Pro"
```

For TestFlight builds:

```bash
pnpm release:ios preflight --build-number=123
pnpm release:ios testflight --build-number=123 --wait
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/contributing/](docs/contributing/),
and [AGENTS.md](AGENTS.md) for conventions and development guides.

## Status

Reflect is in beta and used daily. The current focus is the Mac app, iOS
companion, browser capture, local-first data model, and sync reliability.

Windows, Android, and a plugin API are out of scope for now. See the
[V2 product vision](docs/reflect-v2-product-vision.md) and the implementation
plans in [docs/plans/](docs/plans/) for the longer-term direction.

## License

[MIT](LICENSE).
