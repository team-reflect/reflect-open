// Build the sidecar binaries — the `reflect` CLI (apps/cli, Plan 14) and the
// `reflect-capture-host` native-messaging host (apps/native-host, Plan 11) —
// and stage them where Tauri's sidecar bundling expects them:
// src-tauri/binaries/<name>-<target-triple>[.exe].
//
// Wired into beforeDevCommand/beforeBuildCommand because tauri-build requires
// the triple-suffixed files to exist before the app crate compiles (dev
// included). There is no first-party way to build a Rust sidecar from a
// workspace crate, so this script is the blessed pattern (Plan 14).

import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const platform = process.env.TAURI_ENV_PLATFORM ?? ''
if (platform === 'ios' || platform === 'android') {
  console.log(`build-sidecar: skipping on ${platform} (sidecars are desktop-only)`)
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const binariesDir = join(here, '..', 'src-tauri', 'binaries')

// Tauri exports TAURI_ENV_TARGET_TRIPLE to before-commands; outside of Tauri
// (CI, manual runs) fall back to the host triple.
const triple =
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  execSync('rustc -vV', { encoding: 'utf8' }).match(/^host: (\S+)$/m)?.[1]
if (!triple) {
  throw new Error('build-sidecar: could not determine the target triple from rustc -vV')
}

// crate → binary name, mirroring the `externalBin` entries in the platform
// tauri.*.conf.json overlays.
const SIDECARS = [
  { crate: 'reflect-cli', binary: 'reflect' },
  { crate: 'reflect-capture-host', binary: 'reflect-capture-host' },
]

// The explicit --target keeps the artifacts in target/<triple>/release/ — away
// from target/release/, where tauri-build copies the de-suffixed sidecars —
// and is what makes cross-compilation work.
const packageArgs = SIDECARS.flatMap(({ crate }) => ['-p', crate])
execFileSync('cargo', ['build', '--release', ...packageArgs, '--target', triple], {
  cwd: repoRoot,
  stdio: 'inherit',
})

const extension = triple.includes('windows') ? '.exe' : ''
mkdirSync(binariesDir, { recursive: true })
for (const { binary } of SIDECARS) {
  const built = join(repoRoot, 'target', triple, 'release', `${binary}${extension}`)
  const staged = join(binariesDir, `${binary}-${triple}${extension}`)
  copyFileSync(built, staged)
  console.log(`build-sidecar: staged ${staged}`)
}
