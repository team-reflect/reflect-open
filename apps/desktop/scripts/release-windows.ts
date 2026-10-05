// Builds the unsigned Windows x64 NSIS installer. See docs/windows-builds.md.
//
//   pnpm release:windows [--artifact-dir=<path>]

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  cargoTargetDir,
  flavorConfigArgs,
  flavorOfVersion,
  log,
  readAppVersion,
  tauri,
} from './helpers.ts'

const TARGET = 'x86_64-pc-windows-msvc'

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: true,
    options: { 'artifact-dir': { type: 'string' } },
  })
  const flavor = flavorOfVersion(readAppVersion())

  // NSIS only: WiX rejects prerelease versions such as 0.11.0-beta.
  await tauri(['build', '--target', TARGET, '--bundles', 'nsis', ...flavorConfigArgs(flavor)])

  const bundleDir = join(await cargoTargetDir(), TARGET, 'release', 'bundle', 'nsis')
  const installers = readdirSync(bundleDir).filter((name) => name.endsWith('-setup.exe'))
  const [installer] = installers
  if (!installer || installers.length > 1) {
    throw new Error(`expected one *-setup.exe in ${bundleDir}, found ${installers.length}`)
  }
  log(`installer: ${join(bundleDir, installer)}`)

  const artifactDir = values['artifact-dir']
  if (!artifactDir) return
  mkdirSync(artifactDir, { recursive: true })
  copyFileSync(join(bundleDir, installer), join(artifactDir, installer))
}

await main()
