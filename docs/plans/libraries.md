# Libraries & Dependencies

Canonical record of the libraries chosen for each plan step (decided with the user and
checked against `package.json`/`Cargo.toml` on 2026-06-14). The foundational libraries
installed in Plan 01 are listed first for completeness; later phases name the additions
they bring in. Licensing is **MIT-core** — meowdown is first-party (owned by the team)
and MIT-licensed, so there is no copyleft constraint.

## Installed in Plan 01 (foundation)

- **Monorepo / build:** pnpm workspaces, Turborepo, TypeScript, Vite, `@vitejs/plugin-react`.
- **UI:** React 19, Tailwind CSS v4 (`@tailwindcss/vite`), shadcn primitives via
  `radix-ui`, `clsx` + `tailwind-merge` (the `cn` helper), `lucide-react`.
- **Validation:** `zod`.
- **Database:** `kysely` (query builder, TS); `rusqlite` (bundled) + `sqlite-vec` (Rust).
- **Editor:** meowdown (`@meowdown/react`, `@meowdown/core`) on ProseKit (`@prosekit/*`) +
  `@lezer/markdown`.
- **Forms:** `react-hook-form`.
- **Test:** `vitest`, `@testing-library/react`, `jsdom`.

## TypeScript libraries (additions by plan)

| Need | Library | Plan |
| --- | --- | --- |
| Projection/IPC data cache + invalidation (server-state) | `@tanstack/react-query` | 04 |
| Shared UI / session state (theme, route, palette, sync) | React context + hooks (no external store dependency today) | 06 / 08 |
| Frontmatter YAML (tolerant, round-trippable) | `yaml` (eemeli) | 03 |
| Note IDs (ULID) | `ulidx` | 02 |
| Routing (typed product routes + history) | **custom, no dependency** | 06 |
| Dates (local "today", ISO keys, DST-safe) | `date-fns` (+ `date-fns-tz` if needed) | 06 |
| List virtualization | `@tanstack/react-virtual` | 06 / 08 |
| UI components (dialogs, popovers, menus) | shadcn/ui (on Radix Primitives) | 07 / 08 / 10 / 15 |
| Command palette (⌘K) | `cmdk` | 08 |
| Mobile day carousel (touch swipe, V1 parity) | `embla-carousel-react` | 19 |
| AI provider (BYOK, streaming, multi-provider) | Vercel AI SDK (`ai` + `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`) | 10 |
| Diff / patch (patchsets, conflict diffs) | Not installed; patchsets remain deferred | 10 / 12 |
| Chrome extension framework | WXT | 11 |
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
| SSH transport for generic remotes (agent auth) | `git2` `ssh` feature (vendored libssh2 + openssl) | 16 |
| Local embeddings | `fastembed` | 09 |
| Image processing (screenshot downscale) | `image` | 11 |
| Bounded capture meta fetch | `reqwest` with rustls | 11 |
| CLI framework (derive) | `clap` v4 | 14 |
| CLI local "today" (tz/DST-correct) | `jiff` | 14 |
| CLI content hashes (match TS SHA-256) | `sha2` | 14 |
| CLI frontmatter reads (tolerant YAML) | `saphyr` | 14 |
| CLI first-H1 title fallback | `pulldown-cmark` | 14 |
| Auto-update | `tauri-plugin-updater` | 15 |
| Window-state restore | `tauri-plugin-window-state` | 15 |
| Mobile keyboard bridge | first-party `tauri-plugin-keyboard` | 19 |

## Notes & caveats

- **Plan 13 is closed by product decision:** no ZIP, JSON, HTML export, or dedicated
  Reflect V1 migration dependencies are planned. The graph folder's markdown files and
  assets are the portability surface.
- **The CLI (Plan 14) is a Rust binary** (superseding the earlier `cac` + `node:sqlite`
  Node-CLI choice): rusqlite `bundled` gives the same SQLite + FTS5 as the desktop app via
  one workspace lockfile, and the binary ships as a Tauri sidecar. `saphyr` is chosen for
  read-only frontmatter because `serde_yaml` is unmaintained.
- **`fastembed` (Plan 09)** uses ONNX Runtime, which ships a dylib that must be signed for
  notarization (Plan 15). `candle` (pure Rust, no dylib) was the alternative, not chosen.
- **Auto-update (Plan 15):** first-class via the official Tauri updater plugin
  (`tauri-plugin-updater` + `@tauri-apps/plugin-updater`), updater-signed payloads,
  `latest.json` + artifacts hosted on **GitHub Releases** (static — not a Reflect-hosted
  API). License/dependency scanning stays **manual** for now.
- **Routing (Plan 06)** stays dependency-free: a small typed `Route` union + history stack.
