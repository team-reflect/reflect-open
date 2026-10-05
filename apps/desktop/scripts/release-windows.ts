// Builds the Windows NSIS installer, which is not code-signed. With
// TAURI_SIGNING_PRIVATE_KEY set, Tauri also writes the updater signature
// (`.sig`) of the installer. See docs/windows-builds.md.
//
//   pnpm release:windows [--target=<triple>] [--artifact-dir=<path>]

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  getFlavorConfigArgs,
  getHostTriple,
  log,
  runTauri,
  runWithTempDir,
  TARGET_DIR,
} from './helpers.ts'

/** Builds the installer and returns its path. */
async function buildInstaller(target: string, tempDir: string): Promise<string> {
  // NSIS only: WiX rejects prerelease versions such as 0.11.0-beta.
  const args = ['build', '--target', target, '--bundles', 'nsis', ...getFlavorConfigArgs()]
  const env: NodeJS.ProcessEnv = {}
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    // A config file avoids quoting inline JSON through the `tauri.cmd` shim.
    const updaterConfig = join(tempDir, 'tauri.updater.conf.json')
    writeFileSync(updaterConfig, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }))
    args.push('--config', updaterConfig)
    // Without a password variable, Tauri asks for the password on stdin.
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
  }
  await runTauri(args, env)

  const bundleDir = join(TARGET_DIR, target, 'release', 'bundle', 'nsis')
  const installers = readdirSync(bundleDir).filter((name) => name.endsWith('-setup.exe'))
  const [installer] = installers
  if (!installer || installers.length > 1) {
    throw new Error(`expected one *-setup.exe in ${bundleDir}, found ${installers.length}`)
  }
  return join(bundleDir, installer)
}

/**
 * Copies the installer and its updater signature under the names they are
 * published with: GitHub stores a space in an asset name as a dot.
 */
function exportArtifacts(installer: string, artifactDir: string): void {
  mkdirSync(artifactDir, { recursive: true })
  for (const path of [installer, `${installer}.sig`]) {
    if (existsSync(path)) {
      copyFileSync(path, join(artifactDir, basename(path).replaceAll(' ', '.')))
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'artifact-dir': { type: 'string' },
    },
  })
  const target = values.target ?? (await getHostTriple())
  const installer = await runWithTempDir((tempDir) => buildInstaller(target, tempDir))
  log(`installer: ${installer}`)

  const artifactDir = values['artifact-dir']
  if (artifactDir) {
    exportArtifacts(installer, artifactDir)
  }
}

await main()
