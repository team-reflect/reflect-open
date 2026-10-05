// Builds the sidecar binaries and stages them where tauri-build expects them:
// src-tauri/binaries/<name>-<target-triple>[.exe].

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'tinyexec'
import { log, ROOT_DIR, TAURI_SRC_DIR } from './helpers.ts'

const SIDECARS = [
  { crate: 'reflect-cli', binary: 'reflect' },
  { crate: 'reflect-capture-host', binary: 'reflect-capture-host' },
]
const INHERIT = { throwOnError: true, nodeOptions: { cwd: ROOT_DIR, stdio: 'inherit' } } as const

/** Tauri exports the target triple to its before-commands. Elsewhere, use the host triple. */
async function resolveTriple(): Promise<string> {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE
  }
  const host = await exec('rustc', ['--print', 'host-tuple'], { throwOnError: true })
  return host.stdout.trim()
}

async function main(): Promise<void> {
  const platform = process.env.TAURI_ENV_PLATFORM
  if (platform === 'ios' || platform === 'android') {
    return
  }

  const triple = await resolveTriple()
  // The explicit --target keeps the artifacts out of target/release/, where
  // tauri-build copies the de-suffixed sidecars.
  const packages = SIDECARS.flatMap((sidecar) => ['-p', sidecar.crate])
  await exec('cargo', ['build', '--release', ...packages, '--target', triple], INHERIT)

  const extension = triple.includes('windows') ? '.exe' : ''
  const binariesDir = join(TAURI_SRC_DIR, 'binaries')
  mkdirSync(binariesDir, { recursive: true })
  for (const { binary } of SIDECARS) {
    const staged = join(binariesDir, `${binary}-${triple}${extension}`)
    copyFileSync(join(ROOT_DIR, 'target', triple, 'release', `${binary}${extension}`), staged)
    log(`staged ${staged}`)
  }
}

await main()
