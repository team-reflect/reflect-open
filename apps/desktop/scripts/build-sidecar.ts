// Builds the sidecar binaries and stages them where tauri-build expects them:
// src-tauri/binaries/<name>-<target-triple>[.exe].

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec, hostTriple, log, repoRoot, runMain, SIDECARS, tauriDir } from './helpers.ts'

async function main(): Promise<void> {
  const platform = process.env.TAURI_ENV_PLATFORM
  if (platform === 'ios' || platform === 'android') return

  // Tauri exports the target triple to its before-commands.
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? (await hostTriple())
  // The explicit --target keeps the artifacts out of target/release/, where
  // tauri-build copies the de-suffixed sidecars.
  const packages = SIDECARS.flatMap((sidecar) => ['-p', sidecar.crate])
  await exec('cargo', ['build', '--release', ...packages, '--target', triple], { cwd: repoRoot })

  const extension = triple.includes('windows') ? '.exe' : ''
  const binariesDir = join(tauriDir, 'binaries')
  mkdirSync(binariesDir, { recursive: true })
  for (const { binary } of SIDECARS) {
    const staged = join(binariesDir, `${binary}-${triple}${extension}`)
    copyFileSync(join(repoRoot, 'target', triple, 'release', `${binary}${extension}`), staged)
    log(`staged ${staged}`)
  }
}

await runMain(main)
