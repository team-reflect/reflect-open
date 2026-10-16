// Builds the Linux AppImage and `.deb`, which are not code-signed. With
// TAURI_SIGNING_PRIVATE_KEY set, Tauri also writes the updater signature
// (`.sig`) of each package.
//
//   pnpm release:linux [--target=<triple>] [--artifact-dir=<path>]

import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  exportArtifacts,
  getFlavorConfigArgs,
  getHostTriple,
  log,
  runTauri,
  runWithTempDir,
  TARGET_DIR,
} from './helpers.ts'

const BUNDLES = [
  { name: 'appimage', extension: '.AppImage' },
  { name: 'deb', extension: '.deb' },
]

/** Builds the packages and returns their paths. */
async function buildPackages(target: string, tempDir: string): Promise<string[]> {
  const bundleNames = BUNDLES.map((bundle) => bundle.name).join(',')
  const args = ['build', '--target', target, '--bundles', bundleNames, ...getFlavorConfigArgs()]
  const env: NodeJS.ProcessEnv = {}
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    const updaterConfig = join(tempDir, 'tauri.updater.conf.json')
    writeFileSync(updaterConfig, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }))
    args.push('--config', updaterConfig)
    // Without a password variable, Tauri asks for the password on stdin.
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
  }
  const bundles = BUNDLES.map(({ name, extension }) => ({
    dir: join(TARGET_DIR, target, 'release', 'bundle', name),
    extension,
  }))
  // Tauri keeps the packages of earlier versions in the bundle directories.
  for (const { dir } of bundles) {
    rmSync(dir, { recursive: true, force: true })
  }
  await runTauri(args, env)

  return bundles.map(({ dir: bundleDir, extension }) => {
    const packages = readdirSync(bundleDir).filter((file) => file.endsWith(extension))
    const [found] = packages
    if (!found || packages.length > 1) {
      throw new Error(`expected one *${extension} in ${bundleDir}, found ${packages.length}`)
    }
    return join(bundleDir, found)
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'artifact-dir': { type: 'string' },
    },
  })
  const target = values.target ?? (await getHostTriple())
  const packages = await runWithTempDir((tempDir) => buildPackages(target, tempDir))
  for (const path of packages) {
    log(`package: ${path}`)
  }

  const artifactDir = values['artifact-dir']
  if (artifactDir) {
    exportArtifacts(packages, artifactDir)
  }
}

await main()
