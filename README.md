# Reflect

Plain-file notes for Mac and iPhone: daily notes, wiki links, local search,
and optional AI over your own Markdown.

[![Release](https://img.shields.io/github/v/release/team-reflect/reflect-open)](https://github.com/team-reflect/reflect-open/releases/latest)
[![CI](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml/badge.svg)](https://github.com/team-reflect/reflect-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reflect is an open-source note-taking app built around a folder of Markdown
files. It opens to today's note, lets `[[wiki links]]` connect people,
projects, and ideas, and keeps search and backlinks fast without turning your
notes into an app-only database.

The app does not require a Reflect account. Notes live in a folder you choose,
and optional services such as AI providers, transcription, iCloud, GitHub, or
another git remote are connected directly by the user.

<img width="2926" height="1800" alt="Reflect" src="https://github.com/user-attachments/assets/6da0e0d2-3f25-4fc4-850c-b764548c3abe" />

## Features

- **Daily notes:** the app opens to today's note, and capture defaults there.
- **Wiki links and backlinks:** type `[[` to link notes; each note shows what
  links back to it.
- **Local search:** `⌘K` searches notes, backlinks, and tags. Optional semantic
  search can be enabled locally.
- **Ask your notes:** `⌘J` can query notes through user-provided OpenAI,
  Anthropic, Google, or OpenRouter keys. Answers cite source notes.
- **Private notes:** `private: true` excludes a note's content from AI and
  other external services.
- **Audio memos:** record audio and transcribe it into the daily note with a
  configured transcription provider.
- **Browser capture:** save links, selected text, screenshots, and page text
  from Chrome.
- **Sync choices:** use iCloud Drive for file sync, or git/GitHub for
  versioned backup.
- **CLI:** `reflect today`, `reflect search`, and `reflect show` are available
  for scripts and agents. See [docs/cli.md](docs/cli.md).

## Install

1. **Install the Mac app.** Download the latest macOS DMG from
   [Releases](https://github.com/team-reflect/reflect-open/releases/latest).
   The app is signed, notarized, and auto-updated from GitHub Releases.
2. **Install the iOS beta.** Join
   [TestFlight](https://testflight.apple.com/join/j2eEz43d). The iOS app uses
   the same plain-file graph and sync options as the Mac app.
3. **Install the Chrome extension.** Add
   [Reflect Capture from the Chrome Web Store](https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd)
   to save the current page, selected text, screenshots, and optional page text
   from Chrome.

You can also [build from source](#building-from-source).

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Your Notes Are Files

Reflect calls a notes folder a **graph**. A graph is a folder you can inspect,
back up, sync, or edit with other tools:

```text
my-graph/
├── daily/2026-06-12.md     # Daily notes, named by date
├── notes/some-title.md     # Other notes, named from their titles
├── assets/                 # Images and attachments
└── audio-memos/            # Audio recordings and transcripts
```

Markdown files are the source of truth. Reflect adds search, backlinks, tags,
and related notes on top, but the files remain usable in any Markdown editor.

## Sync and Privacy

For simple file sync across Apple devices, create your graph inside an
iCloud-synced folder such as `iCloud Drive/ReflectGraph`.

For versioned backup or non-iCloud sync, connect GitHub in the app or add
[any SSH git remote](docs/generic-git-remotes.md). Git sync stores the Markdown
graph in a repository you control.

By default, note content stays on the device. External calls only happen after
you configure a provider, connect a git remote, or use a platform sync service.
See [docs/privacy.md](docs/privacy.md) for the full privacy model.

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

## Project Layout

Reflect is a pnpm/Turborepo monorepo:

```text
reflect-open/
├── apps/desktop/          # Mac and iOS app
├── apps/cli/              # `reflect` CLI
├── apps/extension/        # Chrome capture extension
├── apps/native-host/      # Browser capture helper
├── packages/core/         # Shared TypeScript logic
├── packages/db/           # Database types and helpers
├── crates/index-schema/   # Shared index schema
├── design-system/         # Tokens and UI primitives
└── docs/                  # Product, architecture, and contributor docs
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/contributing/](docs/contributing/),
and [AGENTS.md](AGENTS.md) for conventions and development guides.

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

## Status

Reflect is in beta and used daily. The current focus is the Mac app, iOS
companion, browser capture, local-first data model, and sync reliability.

Windows, Android, and a plugin API are out of scope for now. See the
[V2 product vision](docs/reflect-v2-product-vision.md) and the implementation
plans in [docs/plans/](docs/plans/) for the longer-term direction.

## License

[MIT](LICENSE).
