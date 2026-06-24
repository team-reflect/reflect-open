# Plan 15 — Hardening, Packaging & Open-Source Release

**Goal:** Take the feature-complete first wave to a trustworthy, installable, MIT
open-source Mac app: onboarding, accessibility, performance budgets, signing/notarization,
docs, and a release pipeline. This is **M5.**

**Depends on:** all prior plans (gates the release).
**Unlocks:** public launch.

## Scope

**In:** onboarding/first-run, keyboard-map completeness + discoverability, accessibility,
performance budgets, error/repair UX, privacy review, signing/notarization,
MIT licensing and public docs, CI, **auto-update** (Tauri updater plugin), and the
bundled CLI + capture host sidecars.
**Out:** mobile release (active separate track), Windows/Android packaging (later),
publishing/tasks (deferred features). Audio memos and link capture both shipped ahead of
the original release scope and are **in** scope for the privacy/signing review.

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
   12), and provider/key errors (Plan 10) in plain language
   with a clear next action. Verify the recovery story end-to-end: delete `.reflect/` →
   rebuild loses nothing; raw conflict versions recoverable.

6. **Privacy review (release gate).** End-to-end audit that `private: true` is enforced at
   every external call site — copilot (Plan 10), retrieval (Plan 09), audio transcription,
   capture enrichment/meta fetch (Plan 11), and conflict resolution (Plan 12). Confirm
   secrets are keychain-only (never markdown/Git/`.reflect/`) and that no Reflect-hosted
   API exists in the core path. Document exactly what leaves the device and when.

7. **Signing & notarization.** Apple Developer ID signing + notarization for the Tauri
   bundle; verify Gatekeeper-clean install. **Every bundled native dylib must be signed
   with the hardened runtime** — notably the ONNX/embedding runtime (Plan 9) and any
   sqlite-vec/native-messaging-host binaries — for both arm64 and x64; an unsigned nested
   binary fails notarization. Bundle the `reflect` CLI (Plan 14) and
   `reflect-capture-host` (Plan 11) through the macOS Tauri overlay; consider a Homebrew
   cask. Confirm **first release is notarized non-sandboxed** (security-scoped bookmarks,
   Plan 02, only needed if we later sandbox for the App Store). Native-messaging host
   manifests are rewritten on launch for detected browsers, so packaging must verify both
   the sidecar path and manifest registration after app moves/translocation. **Two
   distinct keys:** Apple Developer ID (Gatekeeper/notarization) *and* the Tauri
   **updater signing key** (minisign, verifies update payloads — step 10); both private
   keys live in CI secrets, never in the repo.

8. **Licensing & open-source readiness.** MIT `LICENSE`; per-file headers where
   appropriate; `README` (what/why/install/build), `CONTRIBUTING`, architecture overview
   linking these plans; ensure no proprietary assets/keys are committed. Write as if the
   code is public and will be critiqued — it will be. **The whole stack is MIT-compatible:**
   meowdown is first-party MIT, and the chosen libraries ([Libraries](libraries.md)) are
   permissive. License/dependency scanning is **manual** for now (a periodic audit; no
   automated CI gate yet — revisit if the dep tree grows).

9. **CI + release.** GitHub Actions: typecheck, lint (oxlint), tests, build,
   generated-schema drift check, Rust fmt/clippy/test, Tauri sidecar staging before Rust
   compilation, and a release workflow that runs the repo's `pnpm release:macos publish`
   script to build, code-sign + notarize, **updater-sign**, and publish a GitHub Release
   with the DMG, updater artifacts, and `latest.json` manifest. Bundles the `reflect` CLI
   and `reflect-capture-host` sidecars.

10. **Auto-update (Tauri best practices).** Ship first-class auto-update with the official
    plugin — `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS), paired with
    `@tauri-apps/plugin-process` for relaunch.
    - **Signing:** generate the updater keypair (`tauri signer generate`); the **public key**
      goes in `tauri.conf.json` (`plugins.updater.pubkey`), the **private key** in CI secrets
      (`TAURI_SIGNING_PRIVATE_KEY`). The plugin verifies every downloaded payload against the
      pubkey — distinct from Apple notarization (step 7).
    - **Endpoint:** host the `latest.json` manifest + signed artifacts on **GitHub Releases**
      (static, free, no Reflect-hosted API — consistent with the no-hosted-API principle; this
      is release distribution, not a runtime data service). Config
      `plugins.updater.endpoints` with the `{{target}}`/`{{arch}}`/`{{current_version}}`
      template. macOS updater artifact is the `.app.tar.gz` + `.sig`.
    - **Capabilities:** grant `updater:default` + `process:default` (relaunch) in
      `src-tauri/capabilities/`.
    - **UX:** check on launch (and periodically); when an update is found, show plain-language
      states (`Update available` → `Downloading` → `Restart to update`), download with
      progress, verify, install, and `relaunch()`. Never block the editor; let the user defer.
    - **Channels:** start with a single stable channel; leave room for a beta channel later.
    - **Flavors (shipped):** three coexisting apps via `--config` overlays — Reflect
      (stable, `app.reflect.desktop`, shipped blue/violet icon), Reflect Beta (`…​.beta`,
      magenta), Reflect Dev (`…​.dev`, green, no updates). Beta/dev icons are the stable
      artwork recolored via `magick -modulate`. `release:macos` derives the flavor from the
      version channel. See docs/macos-distribution.md → Build flavors.

11. **Definition-of-success walkthrough.** Manually verify the product-vision success
    list end-to-end (below) as the release checklist.

## Definition of success (release checklist)

A user can: install the Mac app; open today's markdown daily note instantly; write in a
beautiful markdown editor without thinking about files; create `[[Wiki Links]]` naturally;
search locally; ask the Chat view about the current and related notes with their own key;
back up their notes for free; capture a browser page through the extension/native host;
and open their note folder to find portable markdown files.

## Acceptance criteria

- First run reaches a writable today's note in seconds, with backup/AI optional+skippable.
- Every core workflow is keyboard-reachable; `⌘/` lists shortcuts.
- a11y + perf budgets met; deleting `.reflect/` fully rebuilds with no data loss.
- Privacy review passes: `private: true` enforced everywhere; secrets keychain-only; no
  hosted API in the core path.
- Signed, notarized DMG installs Gatekeeper-clean; CLI and capture host are bundled; CI
  green.
- **Auto-update works end-to-end:** an installed older build detects a newer GitHub
  Release, downloads the updater-signed artifact, verifies it against the pubkey, installs,
  and relaunches; a tampered/unsigned payload is rejected.
- MIT licensed with README/CONTRIBUTING/architecture docs.
- The definition-of-success walkthrough passes end-to-end.

## Risks

- **Notarization/signing friction** (CI secrets, provisioning). Start early; don't leave
  it to release week.
- **Perf cliffs on large graphs** surfacing late. Test against a synthetic 10k-note graph
  throughout, not just here.
- **Open-source hygiene** (leaked keys, proprietary assets). Add a secret-scan + license
  check to CI before first public push.
- **Updater key is high-value.** A leaked updater private key lets anyone push a signed
  malicious update. Keep it in CI secrets only, never in the repo/app; plan a rotation
  story (rotating means shipping a build with the new pubkey, so old installs migrate).
  Test the rejected-signature path. Also handle endpoint/Release outages gracefully (the
  app must keep working offline if the update check fails).
