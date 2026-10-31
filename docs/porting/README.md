# Porting Reflect v1 features to Reflect v2

High-level porting plans for the major user-facing features of Reflect v1
(the closed-source, cloud-backed app). Each doc says what the feature did in
v1, what changes in v2 and why, and how it works here, at the level of UX
and architecture. The v1 behavior is documented in the v1 repository under
`docs/user-feature-behavior/`.

## Why features can't be ported directly

- **No server, no accounts.** v1 kept prompts, templates, contacts, and
  credentials in a cloud account. v2 keeps everything in graph files, the
  local settings file, or the OS keychain.
- **No provider OAuth.** OAuth needs a confidential client secret on a
  server; an open-source, client-only app cannot ship one. v2 uses the
  **OS-native stores** (Apple Calendar via EventKit, Apple Contacts), which
  already aggregate the user's Google, Microsoft, and iCloud accounts.
- **Bring your own key.** v1 bundled metered AI with per-plan quotas. v2
  calls OpenAI, Anthropic, Google, or OpenRouter with the user's key (in the
  keychain), so quotas, upgrade prompts, and metering disappear.
- **Files first.** User content (templates, meeting notes) is markdown in
  the graph, backed up by git. Derived data lives in the rebuildable SQLite
  index or is fetched live from the OS; it is never a second source of truth.
- **The privacy flag is law.** `private: true` note content never goes to
  an AI or online service. Every ported AI surface goes through the same
  `CloudSafe` enforcement as the copilot
  (`packages/core/src/privacy/privacy-service.ts`).

## The docs

| Doc                                                                 | v1 feature               | v2 status                                        |
| ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| [Note aliases](./note-aliases.md)                                   | `//` title aliases       | **Ported** (`//` + frontmatter aliases)          |
| [Backlink hover previews](./backlink-hover-previews.md)             | Wiki-link preview        | **Ported** (passive local desktop card)          |
| [Audio memos](./audio-memos.md)                                     | Voice notes + transcript | **Ported** (BYOK transcription) — mapping doc    |
| [AI menu and prompts](./ai-menu-and-prompts.md)                     | Selection AI + prompts   | **Ported** (meowdown selection menu + preview)   |
| [Note templates](./note-templates.md)                               | Per-graph templates      | **Ported** (markdown files in `templates/`)      |
| [Calendar / meetings](./calendar-meetings-integration.md)           | Google/MS/iCloud OAuth   | **Ported** (Apple Calendar via EventKit)         |
| [Contacts](./contacts-integration.md)                               | Google/MS/iCloud OAuth   | **Ported** (Apple Contacts)                      |
| [Assets](./assets.md)                                               | Encrypted uploads + CDN  | **Ported** (images + file attachments)           |
| [Deep links](./deep-links.md)                                       | `reflect://` + web URLs  | **Ported** (route-shaped `reflect://` scheme)    |
| [Editor keyboard shortcuts](./editor-keyboard-shortcuts.md)         | reflect-editor keymaps   | Planned — gap list for meowdown + app            |

## Mobile

The V1 **mobile** app (the separate Capacitor/Ionic `reflect-mobile` repo)
has its own set under [`porting/reflect-mobile/`](./reflect-mobile/README.md).
Those docs defer to [Plan 19](../plans/19-mobile.md) and the
[mobile grounding brief](../reflect-v2-mobile-grounding-brief.md).

## Conventions

- "Graph" is a notes folder; "daily note" is `daily/YYYY-MM-DD.md`.
- `mod` is ⌘ on macOS and Ctrl elsewhere; v2 ships on macOS only.
- **TypeScript owns policy, Rust owns capabilities.** New OS integrations
  are Tauri commands in `apps/desktop/src-tauri/src/`, bound as methods of a
  `@reflect/core` service over `IpcBridgeService`
  (`packages/core/src/ipc/ipc-service.ts`; see
  [adding-a-command](../contributing/adding-a-command.md)). `@reflect/core`
  stays free of Tauri imports.
- Editor-level UI (menus, selection affordances) belongs upstream in
  [meowdown](https://github.com/prosekit/meowdown); Reflect supplies items
  and behavior through props, like wikilink and tag autocomplete.
