// Compiles each flavor's Icon Composer document (`src-tauri/icons*/*.icon`)
// into the `Assets.car` that `bundle.icon` lists for macOS.
//
// Needs Xcode 26 or later.

import { copyFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { exec } from 'tinyexec'
import { runWithTempDir, TAURI_SRC_DIR } from './helpers.ts'

const ICON_DIRS = ['icons', 'icons-beta', 'icons-dev']

async function compile(iconDir: string): Promise<void> {
  const document = readdirSync(iconDir).find((name) => name.endsWith('.icon'))
  if (!document) {
    throw new Error(`No .icon document in ${iconDir}`)
  }
  await runWithTempDir(async (tempDir) => {
    // actool fails with "Bad file descriptor" when it inherits a closed stdin.
    await exec(
      'xcrun',
      [
        'actool',
        join(iconDir, document),
        '--compile',
        tempDir,
        '--output-format',
        'human-readable-text',
        '--errors',
        '--warnings',
        '--output-partial-info-plist',
        join(tempDir, 'partial.plist'),
        '--app-icon',
        basename(document, '.icon'),
        '--include-all-app-icons',
        '--target-device',
        'mac',
        '--minimum-deployment-target',
        '26.0',
        '--platform',
        'macosx',
        // Drops the flat 32 to 1024 px fallback images and keeps one 512 px
        // image, which cuts each `Assets.car` from about 5 MB to about 2 MB.
        '--skip-app-store-deployment',
      ],
      { throwOnError: true, nodeOptions: { stdio: ['ignore', 'inherit', 'inherit'] } },
    )
    copyFileSync(join(tempDir, 'Assets.car'), join(iconDir, 'Assets.car'))
  })
}

for (const dir of ICON_DIRS) {
  await compile(join(TAURI_SRC_DIR, dir))
}
