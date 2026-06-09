# Plan 15 — Hardening, Packaging & Open-Source Release

**Goal:** Take the feature-complete first wave to a trustworthy, installable, MIT
open-source Mac app: onboarding, accessibility, performance budgets, signing/notarization,
docs, and a release pipeline. This is **M5.**

**Depends on:** all prior plans (gates the release).
**Unlocks:** public launch.

## Scope

**In:** onboarding/first-run, keyboard-map completeness + discoverability, accessibility,
performance budgets, error/repair UX, privacy review, signing/notarization, MIT licensing
+ public docs, CI, release/auto-update.
**Out:** mobile release (planned, separate track), Windows/Android (later), publishing/
tasks/audio (deferred features).

## Steps

1. **Onboarding / first run.** A calm flow: pick/create a graph (Plan 02), optional
   GitHub backup setup (Plan 12), optional BYOK key (Plan 10) — all skippable so the app
   is useful immediately. Seed a short "How to use Reflect" note. Model app-ready as the
   explicit states from Plan 06 (no auth/encryption/billing gates exist in V2).

2. **Keyboard completeness + discoverability.** Audit the central keymap (Plan 05) so
   every core workflow has a binding: today, new note, search, `[[`, invoke copilot,
   editor↔sidebar focus, accept/reject AI edits, back/forward. Ship a `⌘/` shortcuts
   cheat-sheet. Keyboard-native is product identity, not polish.

3. **Accessibility.** Focus order + visible focus rings, ARIA on palette/sidebar/dialogs,
   reduced-motion, DS-token contrast in light/dark, screen-reader pass on core flows.

4. **Performance budgets.** Set + measure: cold open to today's note, `⌘K` query latency,
   typing latency on large notes, index rebuild on a 10k-note graph, memory footprint
   (must beat Electron — a stated V2 goal). Add perf smoke tests; fix regressions.

5. **Error, repair & recovery UX.** Surface index repair (Plan 04), backup failures (Plan
   12), provider/key errors (Plan 10), and capture failures (Plan 11) in plain language
   with a clear next action. Verify the recovery story end-to-end: delete `.reflect/` →
   rebuild loses nothing; raw conflict versions recoverable.

6. **Privacy review (release gate).** End-to-end audit that `private: true` is enforced at
   every external call site — copilot (Plan 10), retrieval (Plan 09), capture (Plan 11),
   conflict resolution (Plan 12). Confirm secrets are keychain-only (never markdown/Git/
   `.reflect/`) and that no Reflect-hosted API exists in the core path. Document exactly
   what leaves the device and when.

7. **Signing & notarization.** Apple Developer ID signing + notarization for the Tauri
   bundle; verify Gatekeeper-clean install. **Every bundled native dylib must be signed
   with the hardened runtime** — notably the ONNX/embedding runtime (Plan 9) and any
   sqlite-vec/native-messaging-host binaries — for both arm64 and x64; an unsigned nested
   binary fails notarization. Bundle the `reflect` CLI (Plan 14); consider a Homebrew cask.
   Decide the native-messaging host registration on install (Plan 11). Confirm **first
   release is notarized non-sandboxed** (security-scoped bookmarks, Plan 02, only needed if
   we later sandbox for the App Store).

8. **Licensing & open-source readiness.** MIT `LICENSE`; per-file headers where
   appropriate; `README` (what/why/install/build), `CONTRIBUTING`, architecture overview
   linking these plans; ensure no proprietary assets/keys are committed. Write as if the
   code is public and will be critiqued — it will be.
   - **Resolve the meowdown GPL-3.0 conflict (release gate).** The editor
     (`@meowdown/core`/`@meowdown/react`, Plan 05) is **GPL-3.0-only**; bundling it makes
     the distributed app a combined GPL-3.0 work, incompatible with an MIT core. Pick one
     before public release and update licensing accordingly: (a) **relicense Reflect's
     distributable under GPL-3.0** (legally clean; abandons the MIT-core principle as
     stated); (b) **obtain a more permissive grant / dual-license from the author**
     (ocavue/prosekit — likely the same team), keeping the MIT core; (c) **isolate meowdown
     behind a boundary** sufficient for "mere aggregation" (hard to argue for a core
     editor — legal review required); or (d) **swap the editor** (e.g. the prior
     CodeMirror-6 live-preview option, MIT-compatible). Run a license-compatibility scan
     in CI (step 9) so a GPL/AGPL/proprietary dependency can never slip into an MIT build.

9. **CI + release.** GitHub Actions: typecheck, lint (oxlint adherence config), tests,
   Rust build, Tauri bundle, and a release workflow producing a signed, notarized DMG +
   the CLI. Wire Tauri auto-update for subsequent releases.

10. **Definition-of-success walkthrough.** Manually verify the product-vision success
    list end-to-end (below) as the release checklist.

## Definition of success (release checklist)

A user can: install the Mac app; open today's markdown daily note instantly; write in a
beautiful markdown editor without thinking about files; create `[[Wiki Links]]` naturally;
search locally; ask the AI sidebar about the current and related notes with their own key;
save the current browser page into today's note with screenshot-backed BYOK enrichment;
back up their notes for free; and open their note folder to find portable markdown files.

## Acceptance criteria

- First run reaches a writable today's note in seconds, with backup/AI optional+skippable.
- Every core workflow is keyboard-reachable; `⌘/` lists shortcuts.
- a11y + perf budgets met; deleting `.reflect/` fully rebuilds with no data loss.
- Privacy review passes: `private: true` enforced everywhere; secrets keychain-only; no
  hosted API in the core path.
- Signed, notarized DMG installs Gatekeeper-clean; CLI bundled; CI green.
- MIT licensed with README/CONTRIBUTING/architecture docs.
- The definition-of-success walkthrough passes end-to-end.

## Risks

- **Notarization/signing friction** (CI secrets, provisioning). Start early; don't leave
  it to release week.
- **Perf cliffs on large graphs** surfacing late. Test against a synthetic 10k-note graph
  throughout, not just here.
- **Open-source hygiene** (leaked keys, proprietary assets). Add a secret-scan + license
  check to CI before first public push.
