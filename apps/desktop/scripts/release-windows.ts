// Builds the unsigned Windows x64 NSIS installer. See docs/windows-builds.md.
//
//   pnpm release:windows [--artifact-dir=<path>]

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { getFlavorConfigArgs, log, runTauri, TARGET_DIR } from './helpers.ts'

const TARGET = 'x86_64-pc-windows-msvc'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'artifact-dir': { type: 'string' } },
  })
  // NSIS only: WiX rejects prerelease versions such as 0.11.0-beta.
  await runTauri(['build', '--target', TARGET, '--bundles', 'nsis', ...getFlavorConfigArgs()])

  const bundleDir = join(TARGET_DIR, TARGET, 'release', 'bundle', 'nsis')
  const installers = readdirSync(bundleDir).filter((name) => name.endsWith('-setup.exe'))
  const [installer] = installers
  if (!installer || installers.length > 1) {
    throw new Error(`expected one *-setup.exe in ${bundleDir}, found ${installers.length}`)
  }
  log(`installer: ${join(bundleDir, installer)}`)

  const artifactDir = values['artifact-dir']
  if (!artifactDir) {
    return
  }
  mkdirSync(artifactDir, { recursive: true })
  copyFileSync(join(bundleDir, installer), join(artifactDir, installer))
}

await main()
