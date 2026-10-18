// Compiles each flavor's Icon Composer document (`src-tauri/icons*/*.icon`)
// into the `Assets.car` that `bundle.icon` lists for macOS.
//
// Needs Xcode 26 or later.

import { copyFileSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { exec } from 'tinyexec'
import { z } from 'zod'
import { runWithTempDir, TAURI_SRC_DIR } from './helpers.ts'

const ICON_DIRS = ['icons', 'icons-beta', 'icons-dev']

// The macOS `icon.icns` art is the iOS art cropped to its center 824 px, so
// the macOS icon draws every layer 1024 / 824 times larger than iOS does.
const MAC_LAYER_SCALE = 1024 / 824

const IconDocumentSchema = z.looseObject({
  groups: z.array(
    z.looseObject({
      layers: z.array(
        z.looseObject({
          position: z.looseObject({ scale: z.number() }).optional(),
        }),
      ),
    }),
  ),
})

function scaleLayers(documentDir: string): void {
  const path = join(documentDir, 'icon.json')
  const document = IconDocumentSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  for (const layer of document.groups.flatMap((group) => group.layers)) {
    layer.position = {
      'translation-in-points': [0, 0],
      ...layer.position,
      scale: (layer.position?.scale ?? 1) * MAC_LAYER_SCALE,
    }
  }
  writeFileSync(path, JSON.stringify(document, null, 2))
}

async function compile(iconDir: string): Promise<void> {
  const document = readdirSync(iconDir).find((name) => name.endsWith('.icon'))
  if (!document) {
    throw new Error(`No .icon document in ${iconDir}`)
  }
  await runWithTempDir(async (tempDir) => {
    const input = join(tempDir, document)
    cpSync(join(iconDir, document), input, { recursive: true })
    scaleLayers(input)
    // actool fails with "Bad file descriptor" when it inherits a closed stdin.
    await exec(
      'xcrun',
      [
        'actool',
        input,
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
      ],
      { throwOnError: true, nodeOptions: { stdio: ['ignore', 'inherit', 'inherit'] } },
    )
    copyFileSync(join(tempDir, 'Assets.car'), join(iconDir, 'Assets.car'))
  })
}

for (const dir of ICON_DIRS) {
  await compile(join(TAURI_SRC_DIR, dir))
}
