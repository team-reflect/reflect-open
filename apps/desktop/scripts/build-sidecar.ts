// Builds the sidecar binaries and stages them where tauri-build expects them:
// src-tauri/binaries/<name>-<target-triple>[.exe].

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'tinyexec'
import { getHostTriple, INHERIT, log, TARGET_DIR, TAURI_SRC_DIR } from './helpers.ts'

const SIDECARS = [
  { crate: 'reflect-cli', binary: 'reflect' },
  { crate: 'reflect-capture-host', binary: 'reflect-capture-host' },
]

const UNIVERSAL_TARGET = 'universal-apple-darwin'
const UNIVERSAL_TRIPLES = ['aarch64-apple-darwin', 'x86_64-apple-darwin']

async function main(): Promise<void> {
  const platform = process.env.TAURI_ENV_PLATFORM
  if (platform === 'ios' || platform === 'android') {
    return
  }

  // Tauri exports the target triple to its before-commands.
  const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? (await getHostTriple())
  const triples = target === UNIVERSAL_TARGET ? UNIVERSAL_TRIPLES : [target]
  // The explicit --target keeps the artifacts out of target/release/, where
  // tauri-build copies the de-suffixed sidecars.
  const packages = SIDECARS.flatMap((sidecar) => ['-p', sidecar.crate])
  const targets = triples.flatMap((triple) => ['--target', triple])
  await exec('cargo', ['build', '--release', ...packages, ...targets], INHERIT)

  const extension = target.includes('windows') ? '.exe' : ''
  const binariesDir = join(TAURI_SRC_DIR, 'binaries')
  mkdirSync(binariesDir, { recursive: true })
  for (const { binary } of SIDECARS) {
    const slices = triples.map((triple) => {
      const staged = join(binariesDir, `${binary}-${triple}${extension}`)
      copyFileSync(join(TARGET_DIR, triple, 'release', `${binary}${extension}`), staged)
      log(`staged ${staged}`)
      return staged
    })
    if (target === UNIVERSAL_TARGET) {
      const staged = join(binariesDir, `${binary}-${target}`)
      await exec('lipo', ['-create', '-output', staged, ...slices], INHERIT)
      log(`staged ${staged}`)
    }
  }
}

await main()
