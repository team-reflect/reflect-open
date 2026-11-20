/// <reference lib="dom" />
// Composes the App Store screenshots from the raw screens: a caption at the
// top and the whole device below it, in Apple's bezel ("12z44"). Shots 1, 3
// and 5 use the light theme, 2 and 4 the dark one. Writes
// `screenshots/<device>/NN-<screen>.png` (committed) at the App Store size.
//
// `balanceCaption` runs in the page, hence the DOM types.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

import { BEZELS, bezelPath } from './bezels.ts'
import { RAW_DIR } from './capture.ts'
import { SCREENS, type Screen } from './copy.ts'
import { DEVICES, type DeviceName, type Theme } from './devices.ts'

export const SCREENSHOTS_DIR = join(import.meta.dirname, 'screenshots')

const LOOKS = {
  light: {
    ink: '#0a0a0a',
    muted: '#6b6b70',
    accent: '#4f46e5',
    shadow: 'rgba(0,0,0,.12)',
    paint:
      'radial-gradient(60% 35% at 50% 58%, rgba(129,140,248,.18) 0%, rgba(129,140,248,0) 100%), linear-gradient(180deg, #dfe1ff 0%, #ffffff 100%)',
  },
  dark: {
    ink: '#f4f3fa',
    muted: '#b4b1dc',
    accent: '#a5a0ff',
    shadow: 'rgba(0,0,0,.45)',
    paint:
      'radial-gradient(60% 35% at 50% 58%, rgba(129,140,248,.30) 0%, rgba(129,140,248,0) 100%), linear-gradient(180deg, #23205a 0%, #15123d 100%)',
  },
} as const

const FONT = 'https://fonts.googleapis.com/css2?family=Geist:wght@500;800&display=block'

const dataUrl = (path: string) => `data:image/png;base64,${readFileSync(path).toString('base64')}`

/** The page of one screenshot. */
function screenshotHtml(device: DeviceName, screen: Screen, theme: Theme): string {
  const [W, H] = DEVICES[device].canvas
  const bezel = BEZELS[device]
  const look = LOOKS[theme]
  const u = Math.min(W, H) / 100
  // A landscape canvas (the inner screen of the Duo) has the caption on the
  // left and the device on the right, a portrait one the caption on top.
  const wide = W > H
  const mx = W * (wide ? 0.06 : 0.08)
  const edge = H * 0.06
  const captionWidth = wide ? W * 0.27 : W - 2 * mx
  const titleSize = u * (wide ? 8 : 11.5)
  const textSize = u * (wide ? 3 : 3.6)

  // The caption area fits the longest caption of the set, so every device
  // sits at the same height in all five shots.
  const lines = (text: string, size: number, k: number) =>
    Math.ceil((text.length * k * size) / captionWidth)
  const captionHeight = Math.max(
    ...SCREENS.map(
      (s) =>
        lines(s.title, titleSize, 0.55) * titleSize * 0.98 +
        u * 2.4 +
        lines(s.subtitle, textSize, 0.5) * textSize * 1.4,
    ),
  )
  const captionTop = wide ? (H - captionHeight) / 2 : edge

  // The device, bezel included, is as large as fits in its area. All sizes
  // below are relative to the screen width.
  const area = wide
    ? { x: W * 0.36, y: H * 0.07, width: W * 0.61, height: H * 0.86 }
    : (() => {
        const top = edge + captionHeight + u * 3.5
        return { x: W * 0.06, y: top, width: W * 0.88, height: H - top - H * 0.025 - u * 4 }
      })()
  const fx = bezel.hole.x / W
  const fy = bezel.hole.y / W
  const ratio = H / W
  const width = Math.min(
    area.height / (ratio + 2 * fy),
    area.width / (1 + 2 * fx),
    wide ? Infinity : W * 0.78,
  )
  const k = width / W
  const height = width * ratio
  const left = area.x + (area.width - width) / 2
  const screenTop = area.y + (area.height + (wide ? 0 : u * 4) - height) / 2
  const corners = [bezel.radius]
    .flat()
    .map((r) => `${r * k * 0.92}px`)
    .join(' ')

  const title = screen.title.replace(screen.accent, `<em>${screen.accent}</em>`)
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONT}"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;height:${H}px;overflow:hidden;position:relative;background:${look.paint};-webkit-font-smoothing:antialiased}
.cap{position:absolute;left:${mx}px;top:${captionTop}px;width:${captionWidth}px}
h1{font:800 ${titleSize}px/0.98 Geist,sans-serif;letter-spacing:-0.05em;color:${look.ink};text-wrap:balance}
em{font-style:normal;color:${look.accent}}
p{font:500 ${textSize}px/1.4 Geist,sans-serif;color:${look.muted};margin-top:${u * 2.4}px}
.device{position:absolute;left:${left}px;top:${screenTop}px;width:${width}px;height:${height}px;filter:drop-shadow(0 30px 80px ${look.shadow})}
.screen{position:absolute;inset:0;border-radius:${corners};background:url(${dataUrl(join(RAW_DIR, device, theme, `${screen.id}.png`))}) 0 0/100% 100%}
.bezel{position:absolute;left:${-bezel.hole.x * k}px;top:${-bezel.hole.y * k}px;width:${bezel.size[0] * k}px;height:${bezel.size[1] * k}px;background:url(${dataUrl(bezelPath(device))}) 0 0/100% 100%}
</style></head><body>
<div class="cap${wide ? '' : ' centered'}"><h1>${title}</h1><p>${screen.subtitle}</p></div>
<div class="device"><div class="screen"></div><div class="bezel"></div></div>
</body></html>`
}

/**
 * Runs in the page: wraps the subtitle to the width of the title (at least
 * 72% of the caption), and centers a `.centered` caption on the canvas by its
 * widest line, so the margins left and right of the text match.
 */
function balanceCaption(): void {
  const extent = (elements: Element[]) => {
    let left = Infinity
    let right = -Infinity
    for (const element of elements) {
      const range = document.createRange()
      range.selectNodeContents(element)
      for (const rect of range.getClientRects()) {
        left = Math.min(left, rect.left)
        right = Math.max(right, rect.right)
      }
    }
    return { left, right }
  }
  const caption = document.querySelector<HTMLElement>('.cap')
  const title = document.querySelector('h1')
  const subtitle = document.querySelector<HTMLElement>('p')
  if (!caption || !title || !subtitle) {
    return
  }
  const titleExtent = extent([title])
  subtitle.style.width = `${Math.max(titleExtent.right - titleExtent.left, caption.clientWidth * 0.72)}px`
  if (!caption.classList.contains('centered')) {
    return
  }
  const { left, right } = extent([title, subtitle])
  caption.style.left = `${caption.offsetLeft + (document.body.clientWidth - right - left) / 2}px`
}

async function composeOne(
  page: Page,
  device: DeviceName,
  screen: Screen,
  index: number,
): Promise<void> {
  const [width, height] = DEVICES[device].canvas
  await page.setViewportSize({ width, height })
  await page.setContent(screenshotHtml(device, screen, index % 2 === 0 ? 'light' : 'dark'), {
    waitUntil: 'networkidle',
  })
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(balanceCaption)
  const name = `${String(index + 1).padStart(2, '0')}-${screen.id}.png`
  await page.screenshot({ path: join(SCREENSHOTS_DIR, device, name) })
}

/** Composes the five screenshots of each device in `devices`. */
export async function compose(devices: DeviceName[]): Promise<void> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    for (const device of devices) {
      mkdirSync(join(SCREENSHOTS_DIR, device), { recursive: true })
      for (const [index, screen] of SCREENS.entries()) {
        await composeOne(page, device, screen, index)
      }
    }
  } finally {
    await browser.close()
  }
}
