# Plan 15 — Hardening, Packaging & Open-Source Release

**Goal:** Take the first wave to a trustworthy, installable, MIT open-source Mac app:
onboarding, accessibility, performance budgets, signing/notarization, docs, and a
release pipeline. This is **M5.**

**Depends on:** all prior plans. **Unlocks:** public launch.

## Scope

**In:** first run, keyboard completeness, accessibility, performance budgets,
error/repair UX, privacy review, signing/notarization, MIT licensing + docs, CI,
**auto-update**, and the bundled CLI + capture host sidecars.
**Out:** mobile release (separate track), Windows/Android packaging, publishing/tasks.
Audio memos and link capture shipped early and are **in** the privacy/signing review.

## Steps

1. **First run.** Pick/create a graph, optional GitHub backup, optional BYOK key, all
   skippable so the app is useful at once. Seed a short "How to use Reflect" note. Use
   the Plan 06 app-ready states (V2 has no auth/billing gates).
2. **Keyboard completeness.** Every core workflow has a binding (today, new note, search,
   `[[`, copilot, editor↔sidebar focus, accept/reject AI edits, back/forward). Ship a `⌘/`
   cheat-sheet. Keyboard-native is product identity.
3. **Accessibility.** Focus order + rings, ARIA on palette/sidebar/dialogs, reduced
   motion, token contrast in both themes, screen-reader pass.
4. **Performance budgets.** Cold open to today, `⌘K` latency, typing latency on large
   notes, rebuild on a 10k-note graph, memory (must beat Electron, a stated V2 goal).
5. **Error, repair & recovery UX.** Index repair, backup failures, and provider/key errors
   in plain language with a next action. Verify: delete `.reflect/` → rebuild loses
   nothing; raw conflict versions are recoverable.
6. **Privacy review (release gate).** `private: true` enforced at every external call site
   (copilot, retrieval, transcription, capture meta fetch, conflict resolution). Secrets
   keychain-only; no Reflect-hosted API in the core path. Document what leaves the device.
7. **Signing & notarization.** Developer ID signing + notarization, Gatekeeper-clean.
   **Every bundled native dylib needs hardened-runtime signing** (notably ONNX, sqlite-vec,
   native-messaging host) for arm64 and x64; one unsigned nested binary fails
   notarization. Bundle `reflect` (Plan 14) and `reflect-capture-host` (Plan 11) through
   the macOS Tauri overlay. **First release is notarized non-sandboxed** (security-scoped
   bookmarks only matter for a later App Store sandbox). Native-messaging manifests are
   rewritten on launch, so packaging must verify the sidecar path and manifest after app
   moves/translocation. **Two distinct keys:** Apple Developer ID and the Tauri **updater
   key** (minisign); both private keys live in CI secrets only.
8. **Licensing.** MIT `LICENSE`, README, CONTRIBUTING, architecture overview; no
   proprietary assets/keys committed. The whole stack is MIT-compatible
   ([Libraries](libraries.md)). License scanning is **manual** (periodic audit, no CI gate
   yet; revisit if the dep tree grows).
9. **CI + release.** See `.github/workflows/`: CI checks, and release workflows
   (`release.yml` → `publish-desktop.yml`) that build, sign, notarize, updater-sign, and
   publish a GitHub Release with the DMG, updater artifacts, `latest.json`, and both
   sidecars.
10. **Auto-update** with the official Tauri updater + `@tauri-apps/plugin-process` for
    relaunch.
    - **Signing:** pubkey in `tauri.conf.json`, private key in CI secrets. Separate from
      notarization.
    - **Endpoint:** `latest.json` + signed artifacts on **GitHub Releases**: static, free,
      and release distribution rather than a runtime service, so it fits the
      no-hosted-API principle.
    - **UX:** check on launch and periodically; plain states (`Update available` →
      `Downloading` → `Restart to update`). Never block the editor; the user can defer.
    - **Flavors (shipped):** three coexisting apps via `--config` overlays: Reflect
      (stable), Reflect Beta, Reflect Dev (no updates). Beta/dev icons are the stable
      artwork recolored. The build derives the flavor from the version channel
      (`apps/desktop/scripts/helpers.ts`).
    - **Release automation (shipped):** release-please maintains beta and stable channels
      side by side on `master` (one Release PR per channel). The version lives only in
      `apps/desktop/package.json`. Releases are drafts until assets upload. See
      [docs/distribution.md](../distribution.md).
11. **Definition-of-success walkthrough** as the release checklist.

## Definition of success (release checklist)

A user can: install the Mac app; open today's markdown daily instantly; write without
thinking about files; create `[[Wiki Links]]` naturally; search locally; ask the Chat view
about current and related notes with their own key; back up for free; capture a browser
page via the extension/native host; and find portable markdown files in their folder.

## Acceptance criteria

- First run reaches a writable today's note in seconds; backup/AI are skippable.
- Every core workflow is keyboard-reachable; `⌘/` lists shortcuts.
- a11y + perf budgets met; deleting `.reflect/` rebuilds with no data loss.
- Privacy review passes.
- Signed, notarized DMG installs Gatekeeper-clean with CLI and capture host bundled.
- **Auto-update works end-to-end**, and a tampered/unsigned payload is rejected.
- The definition-of-success walkthrough passes.

## Risks

- **Signing friction** (CI secrets, provisioning). Start early.
- **Perf cliffs on large graphs.** Test against a synthetic 10k-note graph throughout.
- **Open-source hygiene.** Secret-scan + license check before first public push.
- **Updater key is high-value.** A leak lets anyone ship a signed malicious update. Keep
  it in CI secrets; rotation means shipping a build with the new pubkey. Test the
  rejected-signature path. The app must keep working if the update check fails.
