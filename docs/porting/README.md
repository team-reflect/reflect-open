# Porting Reflect v1 features to Reflect v2

This directory holds high-level porting plans for the major user-facing
features of Reflect v1 (the closed-source, cloud-backed app). Each doc
describes what the feature did in v1, what must change in v2 and why, and how
the feature is going to work here — at the level of user experience and
architectural direction, not implementation detail. The v1 behavior these
docs port from is documented in the v1 repository under
`docs/user-feature-behavior/`.

## Why features can't be ported directly

Reflect v2 is built on a different set of constraints than v1, and several v1
designs simply don't survive the move:

- **No server, no accounts.** v1 stored prompts, templates, contacts, and
  credentials in a cloud account. v2 has no backend: everything lives in
  plain files in the graph, in the local settings file, or in the OS
  keychain.
- **No provider OAuth.** v1 connected to Google and Microsoft via OAuth,
  which requires a confidential client secret held on a server. An
  open-source, client-only app cannot ship one. Instead, v2 integrates with
  the **OS-native stores** — Apple Calendar (EventKit) and Apple Contacts —
  which already aggregate the user's Google, Microsoft, and iCloud accounts
  if they are added to macOS.
- **Bring your own key.** v1 bundled metered AI access with per-plan quotas.
  v2 talks directly to OpenAI, Anthropic, Google, or OpenRouter with the user's own key
  (stored in the keychain), so quota tiers, upgrade prompts, and usage
  metering disappear entirely.
- **Files first.** Anything that is user content (templates, notes created
  from meetings) is markdown in the graph, versioned by git backup like
  everything else. Derived data lives in the rebuildable SQLite index or is
  fetched live from the OS; it is never a second source of truth.
- **The privacy flag is law.** `private: true` notes can never have their
  content sent to any AI or online service. Every ported AI surface must go
  through the same `CloudSafe` enforcement as the copilot
  (`packages/core/src/ai/checkers.ts`).

## The docs

| Doc                                                                 | v1 feature               | v2 status                                        |
| ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| [Note aliases](./note-aliases.md)                                   | `//` title aliases       | **Ported** (frontmatter `aliases`) — mapping doc |
| [Backlink hover previews](./backlink-hover-previews.md)             | Wiki-link preview        | Planned — Meowdown hover UI + local loader       |
| [Audio memos](./audio-memos.md)                                     | Voice notes + transcript | **Ported** (BYOK transcription) — mapping doc    |
| [AI menu and prompts](./ai-menu-and-prompts.md)                     | Selection AI + prompts   | Planned — needs meowdown + app work              |
| [Note templates](./note-templates.md)                               | Per-graph templates      | Planned — markdown files in the graph            |
| [Calendar / meetings](./calendar-meetings-integration.md)           | Google/MS/iCloud OAuth   | Planned — Apple Calendar (EventKit)              |
| [Contacts](./contacts-integration.md)                               | Google/MS/iCloud OAuth   | Planned — Apple Contacts                         |
| [Assets](./assets.md)                                               | Encrypted uploads + CDN  | Half ported — images done; attachments planned   |
| [Deep links](./deep-links.md)                                       | `reflect://` + web URLs  | **Ported** (route-shaped `reflect://` scheme)    |
| [Editor keyboard shortcuts](./editor-keyboard-shortcuts.md)         | reflect-editor keymaps   | Planned — gap list for meowdown + app            |

## Mobile

The V1 **mobile** app (the separate Capacitor/Ionic `reflect-mobile`
repo) has its own porting set under
[`porting/reflect-mobile/`](./reflect-mobile/README.md), covering the
Daily carousel, the mobile editor/keyboard experience, audio memos, the
share extension, native entry points, and the mobile sync/offline
contracts. Those docs defer to
[Plan 19](../plans/19-mobile.md) and the
[mobile grounding brief](../reflect-v2-mobile-grounding-brief.md).

## Conventions

- "Graph" is a notes folder; "daily note" is `daily/YYYY-MM-DD.md`.
- `mod` is ⌘ on macOS and Ctrl elsewhere; v2 currently ships on macOS only.
- Architecture references use real paths in this repo, following the
  load-bearing rule from the top-level README: **TypeScript owns policy,
  Rust owns capabilities.** New OS integrations arrive as Tauri commands in
  `apps/desktop/src-tauri/src/`, are consumed through the injected bridge
  (`packages/core/src/ipc/bridge.ts`), and keep `@reflect/core` free of
  Tauri imports.
- Editor-level UI (menus, selection affordances) belongs upstream in
  [meowdown](https://github.com/prosekit/meowdown); Reflect supplies the
  items and behavior through props, the same way wikilink and tag
  autocomplete work today.
