# TDR 0003 — Mobile app shell: Tauri 2 mobile

- **Status:** Accepted
- **Date:** 2026-06-12
- **Scope:** The shell technology for the Reflect mobile companion app (iOS
  first, Android shortly after). The v1 product scope is deliberately small
  but **includes editing as a hard requirement** — browse daily notes, edit
  notes in place, create notes, lexical search, GitHub sync compatible with
  desktop (see [Plan 19](../plans/19-mobile.md)).
- **Decision driver:** Which shell maximizes reuse of the existing stack
  (React + Vite frontend, `@reflect/core` actions, Rust primitives: git2 sync,
  rusqlite FTS5 index, keychain) while staying App-Store-viable and
  Android-portable?
- **Alternatives evaluated:** React Native (bare), Expo, Capacitor, Ionic
  Framework.

---

## TL;DR

**Build mobile with Tauri 2's mobile targets, inside the existing app crate.**
One repo, one Rust core, one IPC layer, one frontend codebase with a mobile
entry surface.

The deciding asset is the Rust core. Reflect's hardest-won, most
correctness-critical code — the git sync engine over libgit2, the SQLite/FTS5
index, keychain secrets — lives in the Tauri crate and compiles to
`aarch64-apple-ios` as-is. Every alternative shell forfeits that and forces a
reimplementation (JS git does not credibly exist for real merge workflows) or a
hand-rolled Rust-to-native bridge that recreates what Tauri already gives us.

We accept that we are early adopters of Tauri mobile and will write a small
amount of Swift (keyboard handling). **Capacitor is the documented fallback** if
Tauri's mobile gaps prove fatal — see [Fallback triggers](#fallback-triggers).

---

## The options

### Tauri 2 mobile (chosen)

Tauri 2 (stable since Oct 2024; 2.11.x as of mid-2026) builds iOS and Android
targets from the same crate as desktop: a thin Swift/Kotlin shell embeds the
system webview, the Rust crate compiles to a static library, and the existing
`@tauri-apps/api` IPC bridge carries the same commands. The repo is already
half-way there: `lib.rs` declares `#[cfg_attr(mobile, tauri::mobile_entry_point)]`,
the updater is `cfg(desktop)`-gated, `tauri ios init` has been run
(`gen/apple/`, `ios.project.yml` with a development team), and the CLI sidecar
is bundled only by the desktop platform overlays.

**What we keep:** the entire Rust primitive surface (git2 with vendored
libgit2/OpenSSL — the GitHub HTTPS + device-flow token path is exactly the
mobile-viable transport; rusqlite with FTS5; keyring's `apple-native` backend,
which covers the iOS keychain), the Kysely-over-IPC read layer, all of
`@reflect/core`, the design system, and the Vite toolchain.

**What we pay (verified, mid-2026):**

- **Keyboard:** the webview is pushed off-screen instead of resized when the
  iOS keyboard opens ([tauri#9907](https://github.com/tauri-apps/tauri/issues/9907),
  open since 2024); `visualViewport` doesn't reflect keyboard height. There is
  no official keyboard plugin (Capacitor has a mature one). We must ship a
  small first-party Swift plugin (keyboard notifications → webview insets +
  height events). This is the single biggest gap and is budgeted in Plan 19.
- **Lifecycle:** iOS kills the WebContent process in the background; apps must
  handle resume-with-dead-webview ([tauri#14371](https://github.com/tauri-apps/tauri/issues/14371),
  fixed upstream — verify the fix is in our pinned version). iOS suspends the
  process shortly after backgrounding; no background sync without
  BGTaskScheduler work (out of v1 scope).
- **Plugin gaps vs Capacitor:** no official share-sheet, push, or keyboard
  plugins (community ones exist, early-stage). Official mobile coverage is
  good for what v1 needs: fs, sql, http, dialog, opener, deep-link, biometric,
  haptics, notification (local).
- **Thin precedent:** no marquee consumer iOS app ships Tauri mobile today.
  App Store submissions exist and the `tauri ios build --export-method
  app-store-connect` path is documented, but we'd be early. Apple's
  guideline 4.2 (minimum functionality) is a low risk for an offline-capable
  local-first app, but it is nonzero for any webview shell.

### Capacitor (strongest alternative; the fallback)

Capacitor 8 (SPM-based on iOS, actively maintained, ~1M weekly downloads) wraps
the same WKWebView around the same Vite `dist/` — frontend reuse is near-total,
and its first-party plugins cover exactly Tauri's gap list: `@capacitor/keyboard`
(resize modes), share, push, app lifecycle events. **Obsidian ships its mobile
apps on Capacitor** — the existence proof that a webview markdown editor at
scale is App-Store-viable and fast.

What disqualifies it as the first choice: **no Rust.** The sync engine would
need libgit2 compiled and bridged through a hand-written Swift/Kotlin plugin
(at which point we are doing Tauri's job without Tauri's tooling), or a JS git
implementation (isomorphic-git cannot do real merges), or — worst — a separate
sync implementation that must stay byte-compatible with desktop's commit/merge
behavior. The index would move to `@capacitor-community/sqlite`, a second
SQLite stack with its own dialect quirks. Our IPC layer (zod-validated
commands, the Kysely-over-IPC dialect) is Tauri-shaped and would need a
parallel Capacitor bridge. Two shells, two native plugin surfaces, two
permission models — for the same webview with the same editor problem.

Worth weighing honestly: the defunct V1 mobile app (`team-reflect/reflect-mobile`)
*was* Capacitor (v6 + Next.js + Firestore), and its deepest recurring pain —
ProseMirror focus/selection/keyboard timing inside WKWebView, webview-crash
recovery, native class-swizzling for the keyboard accessory bar — was **not**
solved by Capacitor's maturity. The hard problem for a notes app is
editor-in-WKWebView, and it is shell-independent. That neutralizes much of
Capacitor's headline advantage for us.

Strategic note: Ionic (the company behind Capacitor) was acquired by
OutSystems, which discontinued all commercial products in Feb 2025 while
keeping Capacitor open source and maintained. Healthy today; bus-factor is
OutSystems' continued interest.

### React Native / Expo

RN 0.85 + Expo SDK 55/56 is the most mature stack with truly native UI — and
the wrong fit here:

- **Frontend reuse ≈ zero.** Everything DOM-based (Tailwind, shadcn, the
  design system, meowdown/ProseKit, TanStack Virtual) is unusable; only hooks
  and pure logic port. This is a full UI rewrite, permanently maintained in
  parallel.
- **The editor problem comes back anyway.** RN's flagship markdown note apps —
  Joplin, Notesnook — embed their editors (CodeMirror 6 / Tiptap) in a
  *webview inside React Native*, inheriting the same WKWebView keyboard pain
  plus an extra RN↔webview bridge. Expensify's `react-native-live-markdown` is
  the native-input exception, but it's tied to their markdown flavor and parser
  architecture.
- **Rust requires uniffi.** `uniffi-bindgen-react-native` works (TurboModules
  from UniFFI-annotated Rust) but adds a second FFI toolchain and xcframework
  build complexity that Tauri gives us for free.
- **The cautionary precedent points the other way.** Standard Notes went
  native → React Native → publicly abandoned RN in 2022 ("React Native is not
  the future") for a single web codebase wrapped on mobile, citing exactly our
  concern: two codebases, mobile permanently lagging.

Expo specifically adds excellent tooling (EAS builds/updates) but none of it
addresses the reuse problem; it optimizes a path we don't want to be on.

### Ionic Framework

A web-component UI kit (iOS/Material adaptive widgets, transitions) layered on
Capacitor. We have our own design system and component library; Obsidian ships
Capacitor without Ionic. Nothing it offers is load-bearing for us. Ruled out
without much ceremony — the real Capacitor question is answered above.

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

Capacitor remains the credible plan B precisely because it wraps the same Vite
frontend. We switch (or re-evaluate) if, during Plan 19's gate spikes:

1. The crate cannot be made to build and run acceptably on iOS (git2/vendored
   OpenSSL cross-compile, keyring-on-iOS, rusqlite/FTS5) within the spike
   budget — this would gut the "keep the Rust core" rationale.
2. Keyboard/viewport behavior cannot reach acceptable quality with a
   first-party Swift plugin (tauri#9907 workaround) — **shell-attributable
   failures only**. Editing quality *inside* the webview (ProseMirror/
   CodeMirror focus, selection, IME) is shell-independent: Capacitor wraps
   the same WKWebView and would inherit the identical problem, so editor
   viability never justifies a shell switch. Plan 19 handles it with an
   editor ladder (meowdown → CodeMirror 6, Obsidian-proven on iOS); if both
   rungs fail, the escalation is native-editor territory (a much bigger
   decision than the shell), taken with the spike data in hand.
3. App Store review rejects the Tauri shell on grounds Capacitor demonstrably
   passes (4.2 / process model), after one appeal cycle.

A fallback would keep `@reflect/core` and the frontend, and would require a
Capacitor bridge implementing the same command surface plus a native sync
plugin — significant, bounded work; not a rewrite.

## Consequences

- Mobile is a **target of the existing app**, not a new app: see
  [Plan 19](../plans/19-mobile.md) for the cfg-gating, capability split,
  mobile frontend entry, and the keyboard plugin.
- We own a small Swift (later Kotlin) surface: keyboard insets now; share
  sheet / share-target later.
- Desktop-only crates get target-gated (`fastembed`, `notify`, `trash`,
  `tauri-plugin-window-state`) — semantic search and file watching are
  desktop-only by design in mobile v1.
- We track Tauri mobile releases closely and pin deliberately; upstream
  keyboard/lifecycle fixes may let us delete our workarounds.
