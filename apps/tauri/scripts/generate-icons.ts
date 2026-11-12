// Compiles each flavor's Icon Composer document
// (`design-system/assets/app-icons/*.icon`) into the `Assets.car` that
// `bundle.icon` lists for macOS.
//
// Needs Xcode 26 or later.

import { copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { exec } from 'tinyexec'
import { runWithTempDir } from '../../../scripts/release.ts'
import { APP_DIR } from './helpers.ts'

const DOCUMENT_DIR = join(APP_DIR, '..', '..', 'design-system', 'assets', 'app-icons')

const ICONS = [
  { dir: 'icons', document: 'AppIcon.icon' },
  { dir: 'icons-beta', document: 'AppIcon-Beta.icon' },
  { dir: 'icons-dev', document: 'AppIcon-Dev.icon' },
]

async function compile(iconDir: string, document: string): Promise<void> {
  await runWithTempDir(async (tempDir) => {
    // actool fails with "Bad file descriptor" when it inherits a closed stdin.
    await exec(
      'xcrun',
      [
        'actool',
        join(DOCUMENT_DIR, document),
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

for (const { dir, document } of ICONS) {
  await compile(join(APP_DIR, dir), document)
}
