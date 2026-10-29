# TDR 0003 — Mobile app shell: Tauri 2 mobile

- **Status:** Accepted
- **Date:** 2026-06-12
- **Scope:** The shell for the Reflect mobile companion app (iOS first, Android
  shortly after). The v1 scope is small but **editing is a hard requirement**:
  browse daily notes, edit in place, create notes, lexical search, GitHub sync
  compatible with desktop ([Plan 19](../plans/19-mobile.md)).
- **Decision driver:** Which shell reuses the most of the existing stack (React
  + Vite, `@reflect/core`, Rust git2 sync, rusqlite FTS5 index, keychain) while
  staying App-Store-viable and Android-portable?
- **Alternatives evaluated:** React Native (bare), Expo, Capacitor, Ionic
  Framework.

---

## TL;DR

**Build mobile with Tauri 2's mobile targets, inside the existing app crate.**
One repo, one Rust core, one IPC layer, one frontend with a mobile entry
surface.

The deciding asset is the Rust core: the libgit2 sync engine, the SQLite/FTS5
index and keychain secrets compile to `aarch64-apple-ios` as-is. Every other
shell forces a reimplementation (JS git cannot do real merges) or a hand-rolled
Rust-to-native bridge that recreates what Tauri gives us.

We accept being early adopters and writing a little Swift (keyboard handling).
**Capacitor is the documented fallback** (see Fallback triggers).

---

## The options

### Tauri 2 mobile (chosen)

Tauri 2 (stable since Oct 2024; 2.11.x as of mid-2026) builds iOS and Android
from the desktop crate: a thin Swift/Kotlin shell embeds the system webview,
the crate compiles to a static library, and the same IPC carries the same
commands. The repo was already half-way there (`mobile_entry_point` in
`lib.rs`, the updater `cfg(desktop)`-gated, `tauri ios init` run, the CLI
sidecar bundled only on desktop).

**What we keep:** the whole Rust surface (git2 with vendored libgit2/OpenSSL,
whose GitHub HTTPS + device-flow path is the mobile-viable transport; rusqlite
with FTS5; keyring's `apple-native` backend for the iOS keychain), the
Kysely-over-IPC reads, all of `@reflect/core`, the design system, and Vite.

**What we pay (verified, mid-2026):**

- **Keyboard:** iOS pushes the webview off-screen instead of resizing it
  ([tauri#9907](https://github.com/tauri-apps/tauri/issues/9907)). There is no
  official keyboard plugin, so we ship a small Swift plugin that pins the
  webview (inset adjustment off, scroll offset held at zero). With the page
  pinned, `visualViewport` reflects the keyboard exactly (verified on iOS
  18.4/26.5, iPhone and iPad): its `resize` fires at the end of the animation,
  ~240ms after the native notification, with no duration.
  `--keyboard-height` derives from it in `use-keyboard.ts`; the plugin's
  native event bridge was removed. iOS 26.0 leaves the viewport stale after
  dismissal ([forums 800125](https://developer.apple.com/forums/thread/800125),
  fixed in 26.1); a focusout watchdog resets the variable.
- **Lifecycle:** iOS kills the WebContent process in the background
  ([tauri#14371](https://github.com/tauri-apps/tauri/issues/14371), fixed
  upstream; verify it is in our pinned version). iOS suspends the app soon
  after backgrounding, so no background sync without BGTaskScheduler (out of
  v1 scope).
- **Plugin gaps:** no official share-sheet, push or keyboard plugins
  (community ones are early). Official coverage fits v1: fs, sql, http, dialog,
  opener, deep-link, biometric, haptics, local notification.
- **Thin precedent:** no marquee consumer iOS app ships Tauri mobile. The
  `tauri ios build --export-method app-store-connect` path is documented, but
  we are early. Guideline 4.2 (minimum functionality) risk is low for an
  offline-capable app, but nonzero for any webview shell.

### Capacitor (strongest alternative; the fallback)

Capacitor 8 (SPM on iOS, actively maintained, ~1M weekly downloads) wraps the
same WKWebView around the same Vite `dist/`, and its first-party plugins cover
Tauri's gaps (`@capacitor/keyboard`, share, push, lifecycle). **Obsidian ships
mobile on Capacitor**, proof that a webview markdown editor is App-Store-viable.

What disqualifies it: **no Rust.** Sync would need libgit2 bridged through a
hand-written Swift/Kotlin plugin (Tauri's job without Tauri's tooling), a JS
git (isomorphic-git cannot do real merges), or a separate implementation kept
byte-compatible with desktop. The index would move to
`@capacitor-community/sqlite`, a second SQLite stack. Our Tauri-shaped IPC
(zod-validated commands, Kysely dialect) would need a parallel bridge.

The defunct V1 mobile app (`team-reflect/reflect-mobile`) *was* Capacitor (v6 +
Next.js + Firestore). Its worst pain (ProseMirror focus/selection/keyboard
timing in WKWebView, webview-crash recovery, swizzling the keyboard accessory
bar) was **not** solved by Capacitor's maturity. Editor-in-WKWebView is
shell-independent, which neutralizes much of Capacitor's advantage.

Strategic note: OutSystems acquired Ionic and discontinued its commercial
products in Feb 2025, keeping Capacitor open source and maintained. The bus
factor is OutSystems' continued interest.

### React Native / Expo

RN 0.85 + Expo SDK 55/56 is the most mature stack with native UI, and the wrong
fit:

- **Frontend reuse ≈ zero.** Tailwind, shadcn, the design system,
  meowdown/ProseKit and TanStack Virtual are DOM-based. Only hooks and pure
  logic port: a full UI rewrite, maintained in parallel.
- **The editor problem returns anyway.** Joplin and Notesnook embed their
  editors (CodeMirror 6 / Tiptap) in a webview inside RN, adding an RN↔webview
  bridge to the same keyboard pain. Expensify's `react-native-live-markdown` is
  the exception, tied to their markdown flavor.
- **Rust requires uniffi.** `uniffi-bindgen-react-native` works but adds a
  second FFI toolchain and xcframework complexity.
- **Precedent points the other way.** Standard Notes went native → React
  Native → abandoned RN in 2022 for one web codebase wrapped on mobile, citing
  two codebases and mobile always lagging.

Expo's tooling (EAS) does not address reuse.

### Ionic Framework

A web-component UI kit on Capacitor. We have our own design system, and
Obsidian ships Capacitor without Ionic. Ruled out; the Capacitor question is
answered above.

## Comparison at a glance

| | Tauri 2 mobile | Capacitor | React Native / Expo |
|---|---|---|---|
| Rust core (git2 sync, FTS5 index, keychain) | **Compiles as-is** | Hand-bridged native plugin or reimplement | uniffi + TurboModules |
| Frontend reuse (React+Vite+design system) | **Full** (mobile entry surface) | **Full** (same webview) | ~None (UI rewrite) |
| Editor (meowdown/ProseMirror) | Works; iOS keyboard is ours to solve | Works; same iOS keyboard problem | Webview-embedded anyway (Joplin pattern) |
| Mobile plugin maturity | Adequate + gaps (keyboard, share) | **Best in class** | Best ecosystem, different problems |
| Repo shape | **One app, one IPC, one crate** | Second shell + second bridge | Second app + second UI |
| Note-app precedent | None shipped | **Obsidian, Logseq** | Joplin, Notesnook (webview editors) |
| Android path | Same crate, `tauri android init` | Same webDir | Same RN app |
| Maturity risk | Early adopter; some Swift on us | Low | Low (but high cost) |

## Fallback triggers

Capacitor stays plan B because it wraps the same frontend. We re-evaluate if,
during Plan 19's gate spikes:

1. The crate cannot build and run acceptably on iOS (git2/vendored OpenSSL,
   keyring, rusqlite/FTS5) within the spike budget.
2. Keyboard/viewport behavior cannot reach acceptable quality with a Swift
   plugin. **Shell-attributable failures only:** editing quality inside the
   webview (focus, selection, IME) is shell-independent, so it never justifies
   a shell switch. Plan 19 handles it with an editor ladder (meowdown →
   CodeMirror 6, Obsidian-proven on iOS); if both fail, the next step is a
   native editor, a bigger decision than the shell.
3. App Store review rejects the Tauri shell on grounds Capacitor passes (4.2 /
   process model), after one appeal.

A fallback keeps `@reflect/core` and the frontend and needs a Capacitor bridge
for the same command surface plus a native sync plugin: significant, bounded,
not a rewrite.

## Consequences

- Mobile is a **target of the existing app**, not a new app
  ([Plan 19](../plans/19-mobile.md)).
- We own a small Swift (later Kotlin) surface: keyboard insets now, share
  sheet / share target later.
- Desktop-only crates are target-gated (`fastembed`, `notify`, `trash`,
  `tauri-plugin-window-state`): semantic search and file watching are
  desktop-only in mobile v1.
- We track Tauri mobile releases and pin deliberately; upstream fixes may let
  us delete our workarounds.
