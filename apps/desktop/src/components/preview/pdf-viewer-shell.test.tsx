import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 最小单页 PDF（300x300），xref 偏移精确生成，pdf.js 无需 recovery 即可解析，
// 避免 recovery 模式的警告噪音。测试中 readAssetBinary 被替换为返回该文档。
const PDF_BYTES = new Uint8Array([
  37, 80, 68, 70, 45, 49, 46, 52, 10, 49, 32, 48, 32, 111, 98, 106, 10, 60, 60, 32, 47, 84, 121,
  112, 101, 32, 47, 67, 97, 116, 97, 108, 111, 103, 32, 47, 80, 97, 103, 101, 115, 32, 50, 32, 48,
  32, 82, 32, 62, 62, 10, 101, 110, 100, 111, 98, 106, 10, 50, 32, 48, 32, 111, 98, 106, 10, 60, 60,
  32, 47, 84, 121, 112, 101, 32, 47, 80, 97, 103, 101, 115, 32, 47, 75, 105, 100, 115, 32, 91, 51,
  32, 48, 32, 82, 93, 32, 47, 67, 111, 117, 110, 116, 32, 49, 32, 62, 62, 10, 101, 110, 100, 111,
  98, 106, 10, 51, 32, 48, 32, 111, 98, 106, 10, 60, 60, 32, 47, 84, 121, 112, 101, 32, 47, 80, 97,
  103, 101, 32, 47, 80, 97, 114, 101, 110, 116, 32, 50, 32, 48, 32, 82, 32, 47, 77, 101, 100, 105,
  97, 66, 111, 120, 32, 91, 48, 32, 48, 32, 51, 48, 48, 32, 51, 48, 48, 93, 32, 47, 82, 101, 115,
  111, 117, 114, 99, 101, 115, 32, 60, 60, 32, 47, 70, 111, 110, 116, 32, 60, 60, 32, 47, 70, 49,
  32, 53, 32, 48, 32, 82, 32, 62, 62, 32, 62, 62, 32, 47, 67, 111, 110, 116, 101, 110, 116, 115, 32,
  52, 32, 48, 32, 82, 32, 62, 62, 10, 101, 110, 100, 111, 98, 106, 10, 52, 32, 48, 32, 111, 98, 106,
  10, 60, 60, 32, 47, 76, 101, 110, 103, 116, 104, 32, 52, 49, 32, 62, 62, 10, 115, 116, 114, 101,
  97, 109, 10, 66, 84, 32, 47, 70, 49, 32, 50, 48, 32, 84, 102, 32, 54, 48, 32, 49, 53, 48, 32, 84,
  100, 32, 40, 72, 105, 41, 32, 84, 106, 32, 69, 84, 10, 101, 110, 100, 115, 116, 114, 101, 97, 109,
  10, 101, 110, 100, 111, 98, 106, 10, 53, 32, 48, 32, 111, 98, 106, 10, 60, 60, 32, 47, 84, 121,
  112, 101, 32, 47, 70, 111, 110, 116, 32, 47, 83, 117, 98, 116, 121, 112, 101, 32, 47, 84, 121,
  112, 101, 49, 32, 47, 66, 97, 115, 101, 70, 111, 110, 116, 32, 47, 72, 101, 108, 118, 101, 116,
  105, 99, 97, 32, 62, 62, 10, 101, 110, 100, 111, 98, 106, 10, 120, 114, 101, 102, 10, 48, 32, 54,
  10, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 32, 54, 53, 53, 51, 53, 32, 102, 32, 10, 48, 48, 48,
  48, 48, 48, 48, 48, 48, 57, 32, 48, 48, 48, 48, 48, 32, 110, 32, 10, 48, 48, 48, 48, 48, 48, 48,
  48, 53, 56, 32, 48, 48, 48, 48, 48, 32, 110, 32, 10, 48, 48, 48, 48, 48, 48, 48, 49, 49, 53, 32,
  48, 48, 48, 48, 48, 32, 110, 32, 10, 48, 48, 48, 48, 48, 48, 48, 50, 52, 49, 32, 48, 48, 48, 48,
  48, 32, 110, 32, 10, 48, 48, 48, 48, 48, 48, 48, 51, 50, 52, 32, 48, 48, 48, 48, 48, 32, 110, 32,
  10, 116, 114, 97, 105, 108, 101, 114, 10, 60, 60, 32, 47, 83, 105, 122, 101, 32, 54, 32, 47, 82,
  111, 111, 116, 32, 49, 32, 48, 32, 82, 32, 62, 62, 10, 115, 116, 97, 114, 116, 120, 114, 101, 102,
  10, 51, 57, 52, 10, 37, 37, 69, 79, 70,
])

vi.mock('@reflect/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reflect/core')>()
  return {
    ...actual,
    readAssetBinary: vi.fn(async () => new Uint8Array(PDF_BYTES)),
  }
})
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))

// pdf.js 在主线程走 fake worker 时读取该全局入口，跳过动态 import
// `/pdf.worker.min.mjs`（测试环境不存在该 URL）。
// @ts-expect-error pdf.js worker 构建未附带类型声明
const { WorkerMessageHandler } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')

const { PdfViewerShell } = await import('./pdf-viewer-shell')

/** 读取工具栏上的缩放百分比展示。 */
function zoomPercent(): number {
  return Number.parseInt(page.getByLabelText('Zoom level').element()?.textContent ?? '', 10)
}

beforeEach(async () => {
  // fake worker 首次初始化会打一次 "Setting up fake worker." 警告——pdf.js
  // 在测试环境下的正常降级路径，非应用噪音，测试内静默。
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('pdfjsWorker', { WorkerMessageHandler })
  await page.viewport(1280, 800)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PdfViewerShell', () => {
  it('opens fitted to the container width with presets and a close button', async () => {
    const onClose = vi.fn()
    await render(<PdfViewerShell assetPath="assets/test.pdf" onClose={onClose} />)

    await expect.element(page.getByRole('button', { name: 'Fit width' })).toBeEnabled()
    // 初始即 page-width：缩放百分比反映容器宽度，而非 100%。
    await expect.poll(() => zoomPercent()).toBeGreaterThan(100)

    // 适配预设按钮渲染，fit-width 处于激活态。
    expect(
      page.getByRole('button', { name: 'Fit width' }).element()?.getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      page.getByRole('button', { name: 'Fit page' }).element()?.getAttribute('aria-pressed'),
    ).toBe('false')
    expect(
      page.getByRole('button', { name: 'Actual size' }).element()?.getAttribute('aria-pressed'),
    ).toBe('false')

    // 顶栏的显眼关闭入口。
    await page.getByRole('button', { name: 'Close preview' }).click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('switches between fit presets and actual size', async () => {
    await render(<PdfViewerShell assetPath="assets/test.pdf" />)
    await expect.element(page.getByRole('button', { name: 'Fit page' })).toBeEnabled()
    const widthZoom = zoomPercent()

    // 300x300 页面在宽而矮的容器里，page-fit（同时考虑高度）必然小于 page-width。
    await page.getByRole('button', { name: 'Fit page' }).click()
    await expect.poll(() => zoomPercent()).toBeLessThan(widthZoom)
    expect(
      page.getByRole('button', { name: 'Fit page' }).element()?.getAttribute('aria-pressed'),
    ).toBe('true')

    await page.getByRole('button', { name: 'Actual size' }).click()
    await expect.poll(() => zoomPercent()).toBe(100)
    expect(
      page.getByRole('button', { name: 'Actual size' }).element()?.getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('re-fits the pages when the container width changes under a fit preset', async () => {
    const view = await render(
      <div style={{ width: 600, height: 600 }}>
        <PdfViewerShell assetPath="assets/test.pdf" />
      </div>,
    )
    await expect.element(page.getByRole('button', { name: 'Fit width' })).toBeEnabled()
    const narrow = zoomPercent()

    // 面板拖宽（分栏 resize 改变容器宽度）：fit-width 应随新宽度重算，
    // 缩放百分比显著上升。
    await view.rerender(
      <div style={{ width: 900, height: 600 }}>
        <PdfViewerShell assetPath="assets/test.pdf" />
      </div>,
    )
    await expect.poll(() => zoomPercent()).toBeGreaterThan(narrow * 1.3)
  })

  it('a manual zoom clears the fit preset so resizes stop re-fitting', async () => {
    const view = await render(
      <div style={{ width: 600, height: 600 }}>
        <PdfViewerShell assetPath="assets/test.pdf" />
      </div>,
    )
    await expect.element(page.getByRole('button', { name: 'Zoom in' })).toBeEnabled()
    expect(
      page.getByRole('button', { name: 'Fit width' }).element()?.getAttribute('aria-pressed'),
    ).toBe('true')

    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect
      .poll(() =>
        page.getByRole('button', { name: 'Fit width' }).element()?.getAttribute('aria-pressed'),
      )
      .toBe('false')

    // 显式缩放值不再跟随容器变化。
    const fixed = zoomPercent()
    await view.rerender(
      <div style={{ width: 900, height: 600 }}>
        <PdfViewerShell assetPath="assets/test.pdf" />
      </div>,
    )
    await expect.poll(() => zoomPercent()).toBe(fixed)
  })

  it('opens a fullscreen overlay with its own chrome and exits via button or Escape', async () => {
    await render(<PdfViewerShell assetPath="assets/test.pdf" />)
    await expect.element(page.getByRole('button', { name: 'Fullscreen' })).toBeEnabled()

    await page.getByRole('button', { name: 'Fullscreen' }).click()
    const dialog = page.getByRole('dialog', { name: 'PDF fullscreen' })
    await expect.element(dialog).toBeInTheDocument()
    // 浮层内是独立工具栏：缩放控制与退出按钮，无重复的进入全屏按钮。
    await expect
      .element(dialog.getByRole('button', { name: 'Exit fullscreen' }))
      .toBeInTheDocument()
    await expect.element(dialog.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: /^Fullscreen$/ }).query()).toBeNull()

    await page.getByRole('button', { name: 'Exit fullscreen' }).click()
    await expect.element(dialog).not.toBeInTheDocument()

    // Escape 同样退出全屏。
    await page.getByRole('button', { name: 'Fullscreen' }).click()
    await expect.element(page.getByRole('dialog', { name: 'PDF fullscreen' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await expect
      .element(page.getByRole('dialog', { name: 'PDF fullscreen' }))
      .not.toBeInTheDocument()
  })

  it('keeps the canvas and text layer geometrically aligned (selection tracks glyphs)', async () => {
    await render(
      <div className="h-[700px] w-[600px]">
        <PdfViewerShell assetPath="assets/test.pdf" />
      </div>,
    )
    await expect.element(page.getByRole('button', { name: 'Fit width' })).toBeEnabled()
    // 文本层 span 渲染完成后再测量。
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.textLayer span').length).toBeGreaterThan(0)
    })

    const canvas = document.querySelector('.canvasWrapper canvas')?.getBoundingClientRect()
    const layer = document.querySelector('.textLayer')?.getBoundingClientRect()
    expect(canvas).toBeDefined()
    expect(layer).toBeDefined()
    if (canvas === undefined || layer === undefined) {
      return
    }
    // 回归防护：pdf.js 的 .page 带 9px 透明边框，若被全局 border-box 吃掉内容
    // 盒，canvas（100%）会缩到 541px 而文本层保持 559px——选区高亮相对文字
    // 垂直/水平错位。修复后两者同尺寸同原点（1px 容差）。
    expect(Math.abs(canvas.width - layer.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(canvas.height - layer.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(canvas.x - layer.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(canvas.y - layer.y)).toBeLessThanOrEqual(1)
  })
})
