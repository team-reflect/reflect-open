# Libraries & Dependencies

Libraries chosen for each plan step (decided with the user, checked against
`package.json`/`Cargo.toml` on 2026-06-14). Licensing is **MIT-core**; meowdown is
first-party and MIT, so there is no copyleft constraint.

## Installed in Plan 01 (foundation)

- **Monorepo / build:** pnpm workspaces, Turborepo, TypeScript, Vite, `@vitejs/plugin-react`.
- **UI:** React 19, Tailwind CSS v4, shadcn primitives via `radix-ui`, `clsx` +
  `tailwind-merge` (`cn`), `lucide-react`.
- **Validation:** `zod`. **Forms:** `react-hook-form`.
- **Database:** `kysely` (TS); `rusqlite` (bundled) + `sqlite-vec` (Rust).
- **Editor:** meowdown (`@meowdown/react`, `@meowdown/core`) on ProseKit + `@lezer/markdown`.
- **Test:** `vitest`, `vitest-browser-react`, `@vitest/browser-playwright`, Playwright.

## TypeScript libraries (additions by plan)

| Need | Library | Plan |
| --- | --- | --- |
| Projection/IPC data cache + invalidation | `@tanstack/react-query` | 04 |
| Shared UI / session state | React context + hooks (no external store) | 06 / 08 |
| Frontmatter YAML (tolerant, round-trippable) | `yaml` (eemeli) | 03 |
| Note IDs (ULID) | `ulid` | 02 |
| Routing (typed product routes + history) | **custom, no dependency** | 06 |
| Dates (local "today", ISO keys, DST-safe) | `date-fns` (+ `date-fns-tz` if needed) | 06 |
| List virtualization | `@tanstack/react-virtual` | 06 / 08 |
| UI components | shadcn/ui (on Radix Primitives) | 07 / 08 / 10 / 15 |
| Command palette (⌘K) | `cmdk` | 08 |
| Mobile day carousel (touch swipe, V1 parity) | `embla-carousel-react` | 19 |
| AI provider (BYOK, streaming, multi-provider) | Vercel AI SDK (`ai` + `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`) | 10 |
| Diff / patch | Not installed; patchsets deferred | 10 / 12 |
| Chrome extension framework | WXT | 11 |
| Auto-update (JS API + relaunch) | `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process` | 15 |

## Rust crates (additions by plan)

| Need | Crate | Plan |
| --- | --- | --- |
| SQLite (bundled, FTS5) | `rusqlite` (feature `bundled`) | 04 |
| Vector search | `sqlite-vec` | 09 |
| File watching | `notify` + `notify-debouncer-full` | 02 / 04 |
| Content hashing | `blake3` | 04 |
| Atomic writes (temp + rename) | `tempfile` | 02 |
| Delete to OS trash | `trash` | 02 |
| Note IDs (ULID) | `ulid` | 02 |
| Keychain / secrets | `keyring` | 10 / 12 |
| Git | `git2` (libgit2) | 12 |
| SSH transport for generic remotes | `git2` `ssh` feature (vendored libssh2 + openssl) | 16 |
| Local embeddings | `fastembed` | 09 |
| Image processing (screenshot downscale) | `image` | 11 |
| Bounded capture meta fetch | `reqwest` with rustls | 11 |
| CLI framework | `clap` v4 | 14 |
| CLI local "today" (tz/DST-correct) | `jiff` | 14 |
| CLI content hashes (match TS SHA-256) | `sha2` | 14 |
| CLI frontmatter reads | `saphyr` | 14 |
| CLI first-H1 title fallback | `pulldown-cmark` | 14 |
| Auto-update | `tauri-plugin-updater` | 15 |
| Window-state restore | `tauri-plugin-window-state` | 15 |
| Mobile keyboard bridge | first-party `tauri-plugin-keyboard` | 19 |

## Notes & caveats

- **Plan 13 is closed by product decision:** no ZIP/JSON/HTML export or V1 migration
  dependencies. The graph folder's markdown and assets are the portability surface.
- **The CLI (Plan 14) is a Rust binary** (replacing the earlier `cac` + `node:sqlite`
  choice): bundled rusqlite gives the same SQLite + FTS5 as the app via one lockfile, and
  it ships as a Tauri sidecar. `saphyr` was chosen because `serde_yaml` is unmaintained.
- **`fastembed` (Plan 09)** uses ONNX Runtime, whose dylib must be signed for
  notarization. `candle` (pure Rust, no dylib) was the rejected alternative.
- **Auto-update (Plan 15):** official Tauri updater plugin, updater-signed payloads,
  `latest.json` + artifacts on **GitHub Releases** (static, not a Reflect-hosted API).
  License/dependency scanning stays **manual**.
- **Routing (Plan 06)** stays dependency-free: a small typed `Route` union + history stack.
