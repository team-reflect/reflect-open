// Builds the sidecar binaries and stages them where tauri-build expects them:
// src-tauri/binaries/<name>-<target-triple>[.exe].
//
// The Rust CI jobs run this file without `pnpm install`, so it must not import
// npm packages.

import { execFileSync } from 'node:child_process'// FIXME: use `exec` from `tinyexec`
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SIDECARS = [
  { crate: 'reflect-cli', binary: 'reflect' },
  { crate: 'reflect-capture-host', binary: 'reflect-capture-host' },
]
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const binariesDir = join(import.meta.dirname, '..', 'src-tauri', 'binaries') // FIXME: use helpers.ts etc. Do Not Repeat Yourself.

function main(): void {
  const platform = process.env.TAURI_ENV_PLATFORM
  if (platform === 'ios' || platform === 'android') return

  // Tauri exports the target triple to its before-commands.
  const triple =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
  // The explicit --target keeps the artifacts out of target/release/, where
  // tauri-build copies the de-suffixed sidecars.
  const packages = SIDECARS.flatMap((sidecar) => ['-p', sidecar.crate])
  execFileSync('cargo', ['build', '--release', ...packages, '--target', triple], {
    cwd: repoRoot,
    stdio: 'inherit',
  })

  const extension = triple.includes('windows') ? '.exe' : ''
  mkdirSync(binariesDir, { recursive: true })
  for (const { binary } of SIDECARS) {
    const staged = join(binariesDir, `${binary}-${triple}${extension}`)
    copyFileSync(join(repoRoot, 'target', triple, 'release', `${binary}${extension}`), staged)
    console.log(`build-sidecar: staged ${staged}`)
  }
}

main()
