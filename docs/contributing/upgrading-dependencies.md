# Upgrading dependencies

Rules for manual or agent-driven npm/Cargo bumps. Renovate handles many
routine updates; follow this when doing the bump yourself.

## Rules

1. **min-release-age ≥ 24h** — only versions published at least 24 hours ago,
   unless `pnpm-workspace.yaml` already explicitly allows otherwise. Skip
   prereleases unless explicitly allowed.
2. **Edit source manifests** (`package.json`, `Cargo.toml`), then regenerate
   locks (`pnpm-lock.yaml`, `Cargo.lock`). No lock-only bumps.
3. **Run `pnpm dedupe`** after npm bumps and commit any lockfile changes.
4. **Never change `pnpm-workspace.yaml`.**
5. **Draft PR** — create a draft GitHub PR.
6. **Title:** `chore(deps): update XXXX`.
7. **Local Node *and* Rust build+lint must pass** before opening/pushing as
   ready; then CI `all-green` must pass.
8. Branch from latest `origin/master`.

## Tauri alignment

Bump Rust + npm together: workspace `tauri` / `tauri-plugin`,
`apps/desktop/src-tauri` `tauri-build` + `tauri-plugin-*`, and
`apps/desktop` `@tauri-apps/api`, `@tauri-apps/cli`, `@tauri-apps/plugin-*`.
Keep majors aligned; path plugins under `plugins/` pick up workspace pins.

## Local checks

```bash
pnpm install && pnpm dedupe && pnpm typecheck && pnpm lint && pnpm build

node apps/desktop/scripts/build-sidecar.mjs
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace
```

## PR body

For each upgraded package: **old → new**, real changelog/release URL, and a
short summary from the notes (do not invent).
