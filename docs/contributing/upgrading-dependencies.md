# Upgrading dependencies

How to bump npm and Cargo dependencies in this monorepo — especially the
Tauri stack — so automated bots and human contributors follow the same
rules. Renovate already opens many routine bumps; use this guide for
manual or agent-driven upgrades (Tauri core + plugins, grouped stacks, or
anything Renovate cannot age-gate yet on the Cargo side).

## Hard rules

1. **Minimum release age ≥ 24 hours.** Only take versions whose npm /
   crates.io publish time (or GitHub Release time) is at least 24 hours
   before *now*. Skip prereleases (`alpha` / `beta` / `rc`) unless the
   task explicitly allows them. This matches Renovate’s
   `minimumReleaseAge: "1 days"` for grouped npm deps
   (`renovate.json` → `github>ocavue/config-renovate`).
2. **Edit source manifests, then regenerate locks.** Bump pins in
   `package.json`, root `Cargo.toml` (`[workspace.dependencies]`),
   `apps/desktop/src-tauri/Cargo.toml`, etc. Then refresh
   `pnpm-lock.yaml` / `Cargo.lock`. Do not ship lock-only changes when
   the intent is a version bump.
3. **Never change `pnpm-workspace.yaml`.** Verify with
   `git diff -- pnpm-workspace.yaml` (must be empty) before commit.
4. **No fork.** Push the branch directly to `team-reflect/reflect-open`.
5. **Draft PR** for automated / agent dep bumps: `gh pr create --draft`.
6. **PR title format:** `chore(deps): update XXXX` for a single package
   or small group, or `chore(deps): upgrade Tauri` for a Tauri stack
   bump. Keep it short — CI enforces Conventional Commits on the title,
   and squash-merge uses that title as the commit message.
7. **Local Node *and* Rust build + lint must pass** before opening the
   PR or treating it as ready. Then watch CI until `all-green` passes;
   fix and push until it does.
8. Branch from latest `origin/master` (do not build on a stale detached
   `HEAD`).

## Find what to upgrade

```bash
git fetch origin master
git checkout -B chore/upgrade-<name> origin/master

# JS / npm
git grep -nE '@tauri-apps|tauri' -- '**/package.json' 'package.json'

# Rust crates
git grep -nE 'tauri' -- '**/Cargo.toml' 'Cargo.toml'
```

Resolve the **latest eligible** version from npm and crates.io. Prefer
matching majors across Tauri core and plugins (stay on Tauri 2.x until a
deliberate 3.x migration). crates.io’s HTTP API expects a `User-Agent`.

## Keep the Tauri stack aligned

When upgrading Tauri, bump **both** ecosystems in lockstep where a
matching package exists:

| Layer | Where | Examples |
| --- | --- | --- |
| Workspace Rust | root `Cargo.toml` → `[workspace.dependencies]` | `tauri`, `tauri-plugin` |
| App Rust | `apps/desktop/src-tauri/Cargo.toml` | `tauri-build`, `tauri-plugin-*` |
| App npm | `apps/desktop/package.json` | `@tauri-apps/api`, `@tauri-apps/cli`, `@tauri-apps/plugin-*` |

First-party plugins under `plugins/tauri-plugin-*` use
`tauri = { workspace = true }` / `tauri-plugin = { workspace = true }` —
bumping the workspace pins is enough for those path crates.

Leave packages already at the latest eligible stable unchanged, and say
so in the PR body. Do not take Tauri 3 alphas unless asked.

## Node (pnpm)

`packageManager` is pinned in the root `package.json`. Prefer pnpm
everywhere.

```bash
corepack enable
pnpm install          # after package.json edits → refreshes pnpm-lock.yaml
pnpm typecheck
pnpm lint             # oxfmt + oxlint + eslint
pnpm build            # turbo (desktop Vite, etc.)
# optional: pnpm test --run path/to/relevant.test.ts
```

## Rust (cargo)

CI `rust-lint` runs `cargo fmt --all -- --check` and
`cargo clippy --workspace --all-targets -- -D warnings`. CI `rust-test`
runs `cargo test --workspace`. Current Tauri crates need **Rust ≥ 1.90**
(use rustup `stable`).

On Linux, install the WebKit/GTK packages the same way as
[`.github/actions/setup-rust`](../../.github/actions/setup-rust/action.yml),
and **stage the CLI sidecar before compiling the desktop crate**
(tauri-build expects the binaries to exist):

```bash
rustup component add rustfmt clippy

sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libxdo-dev libssl-dev build-essential curl wget file patchelf

# after Cargo.toml bumps:
cargo update -p <crate> …    # refresh Cargo.lock for the bumped crates
node apps/desktop/scripts/build-sidecar.mjs

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace
# optional: cargo test --workspace
```

**Gotcha:** a newer Rust stable can deprecate std APIs (for example
`AtomicUsize::fetch_update` → `try_update`). Clippy with `-D warnings`
fails the job — fix the call site in the same PR when the upgrade
surfaces it.

## PR description

For **each** upgraded package or crate, include:

- **before → after** version
- a **real** changelog / GitHub Release URL (Tauri core:
  `tauri-apps/tauri` tags; plugins: `tauri-apps/plugins-workspace` tags,
  including `*-js-v*` / `@tauri-apps/api-v*` for npm)
- a **short summary of what that upgrade changed**, taken from the
  release notes — do not invent

Also state the age-gate cutoff you used, that `pnpm-workspace.yaml` is
unchanged, and which local Node/Rust commands passed.

## Open the draft PR and watch CI

```bash
git add Cargo.toml Cargo.lock \
  apps/desktop/package.json apps/desktop/src-tauri/Cargo.toml \
  pnpm-lock.yaml
# never stage pnpm-workspace.yaml
git diff -- pnpm-workspace.yaml   # must be empty

git commit -m "chore(deps): upgrade Tauri"
git push -u origin HEAD

gh pr create --draft --base master \
  --title "chore(deps): upgrade Tauri" \
  --body-file ./pr-body.md

gh pr checks <n> --watch
# if red:
gh run view <run_id> --job <job_id> --log-failed
```

Required CI signal: the **`all-green`** job (and the underlying
`node-lint`, `node-test`, `rust-lint`, `rust-test`, `apple-lint`, and
conventional-title check). Draft PRs still run CI.

## Checklist before “done”

- [ ] Source manifests + locks updated; `pnpm-workspace.yaml` untouched
- [ ] Versions age-gated (≥ 24h) and stable
- [ ] Tauri core / plugins / `@tauri-apps/*` kept aligned where applicable
- [ ] Local: `pnpm typecheck && pnpm lint && pnpm build`
- [ ] Local: `cargo fmt --check`, `cargo clippy -D warnings`,
      `cargo build --workspace`
- [ ] Draft PR on `team-reflect/reflect-open` (no fork)
- [ ] Title matches `chore(deps): update XXXX` / `chore(deps): upgrade Tauri`
- [ ] PR body has per-package before→after, changelog URLs, and note summaries
- [ ] CI green (`all-green`)
