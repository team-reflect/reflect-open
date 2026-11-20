// Apple's device bezels (https://developer.apple.com/design/resources/).
// Their license does not allow redistribution, so they are downloaded into
// `out/bezels/` and never committed. `7zz` (`brew install sevenzip`) takes
// the PNG out of the disk image without mounting it.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from 'tinyexec'

import type { DeviceName } from './devices.ts'

const CDN = 'https://devimages-cdn.apple.com/design/resources/download/'
const DIR = join(import.meta.dirname, 'out', 'bezels')

export interface Bezel {
  dmg: string
  /** The path of the PNG in the disk image. */
  png: string
  /** The size of the PNG in px. */
  size: readonly [width: number, height: number]
  /** The transparent screen area of the PNG in px, the size of the screenshot. */
  hole: { x: number; y: number }
  /** The corner radius of the screen in px: one value, or top-left, top-right, bottom-right, bottom-left. */
  radius: number | readonly [number, number, number, number]
}

export const BEZELS: Record<DeviceName, Bezel> = {
  iphone: {
    dmg: 'Bezel-iPhone-18.dmg',
    png: 'iPhone 18 Pro Max - Black - Portrait.png',
    size: [1470, 3000],
    hole: { x: 75, y: 66 },
    radius: 188,
  },
  'iphone-medium': {
    dmg: 'Bezel-iPhone-18.dmg',
    png: 'iPhone 18 Pro - Black - Portrait.png',
    size: [1350, 2760],
    hole: { x: 72, y: 69 },
    radius: 188,
  },
  ipad: {
    dmg: 'Bezel-iPad-Pro-(M5).dmg',
    png: 'iPad Pro (M5) 13" - Space Black - Portrait.png',
    size: [2300, 3000],
    hole: { x: 118, y: 124 },
    radius: 58,
  },
  'ipad-11': {
    dmg: 'Bezel-iPad-Pro-(M5).dmg',
    png: 'iPad Pro (M5) 11" - Space Black - Portrait.png',
    size: [1880, 2640],
    hole: { x: 106, y: 110 },
    radius: 58,
  },
  'duo-outer': {
    dmg: 'Bezel-iPhone-Duo.dmg',
    png: 'iPhone Duo - Night Sky - Outer Closed Portrait.png',
    size: [1574, 2194],
    hole: { x: 88, y: 80 },
    radius: [24, 174, 174, 24],
  },
  'duo-inner': {
    dmg: 'Bezel-iPhone-Duo.dmg',
    png: 'iPhone Duo - Night Sky - Inner Open Landscape.png',
    size: [3093, 2247],
    hole: { x: 120, y: 120 },
    radius: 160,
  },
}

/** The bezel PNG of `device`. */
export function bezelPath(device: DeviceName): string {
  return join(DIR, `${device}.png`)
}

/**
 * Downloads the bezels that `devices` need and are not in `out/bezels/` yet.
 * A disk image is 100 to 500 MB, so it stays in `out/bezels/dmg/`.
 */
export async function downloadBezels(devices: DeviceName[]): Promise<void> {
  const missing = devices.filter((device) => !existsSync(bezelPath(device)))
  for (const dmg of new Set(missing.map((device) => BEZELS[device].dmg))) {
    const file = join(DIR, 'dmg', dmg)
    if (!existsSync(file)) {
      mkdirSync(join(DIR, 'dmg'), { recursive: true })
      console.log(`[store-screenshots] download ${dmg}`)
      await exec('curl', ['-fsSL', '-o', `${file}.part`, CDN + encodeURIComponent(dmg)], {
        throwOnError: true,
        nodeOptions: { stdio: 'inherit' },
      })
      renameSync(`${file}.part`, file)
    }
    for (const device of missing.filter((name) => BEZELS[name].dmg === dmg)) {
      const work = mkdtempSync(join(tmpdir(), 'bezel-'))
      try {
        // `-r`: the PNG at any depth of the image.
        await exec('7zz', ['x', '-y', `-o${work}`, file, '-r', BEZELS[device].png], {
          throwOnError: true,
        })
        const { stdout } = await exec('find', [work, '-name', BEZELS[device].png], {
          throwOnError: true,
        })
        const png = stdout.split('\n')[0]
        if (!png) {
          throw new Error(`${BEZELS[device].png} is not in ${dmg}`)
        }
        copyFileSync(png, bezelPath(device))
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    }
  }
}
