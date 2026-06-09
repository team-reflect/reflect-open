# Libraries & Dependencies

Canonical record of the libraries chosen for each plan step (decided with the user). The
foundational libraries installed in Plan 01 are listed first for completeness; later
phases name the additions they bring in. Licensing is **MIT-core** — meowdown is
first-party (owned by the team) and MIT-licensed, so there is no copyleft constraint.

## Installed in Plan 01 (foundation)

- **Monorepo / build:** pnpm workspaces, Turborepo, TypeScript, Vite, `@vitejs/plugin-react`.
- **UI:** React 19, Tailwind CSS v4 (`@tailwindcss/vite`), `clsx` + `tailwind-merge` (the
  `cn` helper), `lucide-react`.
- **Validation:** `zod`.
- **Database:** `kysely` (query builder, TS); `rusqlite` (bundled) + `sqlite-vec` (Rust).
- **Editor:** meowdown (`@meowdown/react`, `@meowdown/core`) on ProseKit (`@prosekit/*`) +
  `@lezer/markdown`.
- **Forms:** `react-hook-form`.
- **Test:** `vitest`, `@testing-library/react`, `jsdom`.

## TypeScript libraries (additions by plan)

| Need | Library | Plan |
| --- | --- | --- |
| Frontmatter YAML (tolerant, round-trippable) | `yaml` (eemeli) | 03 |
| Note IDs (ULID) | `ulidx` | 02 |
| Routing (typed product routes + history) | **custom, no dependency** | 06 |
| Dates (local "today", ISO keys, DST-safe) | `date-fns` (+ `date-fns-tz` if needed) | 06 |
| List virtualization | `@tanstack/react-virtual` | 06 / 08 |
| UI components (dialogs, popovers, menus) | shadcn/ui (on Radix Primitives) | 07 / 08 / 10 / 15 |
| Command palette (⌘K) | `cmdk` | 08 |
| AI provider (BYOK, streaming, multi-provider) | Vercel AI SDK (`ai` + `@ai-sdk/openai` …) | 10 |
| Diff / patch (patchsets, conflict diffs) | `diff` (jsdiff) | 10 / 12 |
| Export — ZIP | `fflate` (client-side) | 13 |
| Export — HTML | reuse the editor: `markdownToDoc` → ProseMirror `DOMSerializer` (no remark) | 13 |
| Chrome extension framework | WXT | 11 |
| CLI framework | `cac` | 14 |
| CLI SQLite read | `node:sqlite` (built-in, Node 22+) | 14 |
| Auto-update (JS API + relaunch) | `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process` | 15 |

## Rust crates (additions by plan)

| Need | Crate | Plan |
| --- | --- | --- |
| SQLite (bundled, FTS5) | `rusqlite` (feature `bundled`) | 04 |
| Vector search | `sqlite-vec` | 09 |
| File watching | `notify` + `notify-debouncer-full` | 02 / 04 |
| Content hashing (change detection) | `blake3` | 04 |
| Atomic writes (temp + rename) | `tempfile` | 02 |
| Delete to OS trash | `trash` | 02 |
| Note IDs (ULID) | `ulid` | 02 |
| Keychain / secrets | `keyring` | 10 / 12 |
| Git (commits, merge, conflicts) | `git2` (libgit2) | 12 |
| Local embeddings | `fastembed` | 09 |
| Image processing (screenshot downscale) | `image` | 11 |
| Auto-update | `tauri-plugin-updater` | 15 |

## Notes & caveats

- **Export is fully client-side (TS):** `fflate` for zipping; HTML rendered by reusing the
  editor's ProseMirror schema + `DOMSerializer` (no remark, reuses libraries we already
  ship). Rust just persists the produced bytes to a chosen path.
- **`node:sqlite` (Plan 14)** is still experimental in Node — verify FTS5 is available in
  the runtime's bundled SQLite before relying on `reflect search`; `better-sqlite3` is the
  fallback if not.
- **`fastembed` (Plan 09)** uses ONNX Runtime, which ships a dylib that must be signed for
  notarization (Plan 15). `candle` (pure Rust, no dylib) was the alternative, not chosen.
- **Auto-update (Plan 15):** first-class via the official Tauri updater plugin
  (`tauri-plugin-updater` + `@tauri-apps/plugin-updater`), updater-signed payloads,
  `latest.json` + artifacts hosted on **GitHub Releases** (static — not a Reflect-hosted
  API). License/dependency scanning stays **manual** for now.
- **Routing (Plan 06)** stays dependency-free: a small typed `Route` union + history stack.
