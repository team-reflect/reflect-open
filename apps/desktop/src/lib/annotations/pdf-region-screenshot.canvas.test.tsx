import { describe, expect, it, vi } from 'vitest'
import { canvasToPngBlob, copyBorderReference, renderRegion } from './pdf-region-screenshot'
import type { AnnotationItem } from './annotations-store'

function item(partial: Partial<AnnotationItem>): AnnotationItem {
  return {
    id: 'a1',
    pageIndex: 2,
    type: 'border',
    rects: [[0.2, 0.1, 0.6, 0.4]],
    color: '#FFD400',
    text: '',
    ...partial,
  }
}

/** A mock pdf.js page whose render resolves and whose viewport clones shift. */
function pageMock() {
  return {
    getViewport: vi.fn((options: { scale: number }) => ({
      width: 300 * options.scale,
      height: 200 * options.scale,
      clone: vi.fn((cloneOptions: { offsetX: number; offsetY: number; scale?: number }) => ({
        scale: cloneOptions.scale ?? options.scale,
        offsetX: cloneOptions.offsetX,
        offsetY: cloneOptions.offsetY,
      })),
    })),
    // pdf.js render() returns a task synchronously; its `.promise` is the
    // awaitable part.
    render: vi.fn(() => ({ promise: Promise.resolve() })),
  }
}

describe('renderRegion', () => {
  it('sizes the canvas to the region at the resolution and renders with a shifted viewport', async () => {
    const page = pageMock()
    const canvas = document.createElement('canvas')

    expect(await renderRegion(page as never, [0.2, 0.1, 0.6, 0.4], canvas, 2)).toBe(true)
    expect(canvas.width).toBe(240)
    expect(canvas.height).toBe(120)
    // The render viewport is the page viewport scaled to the region, cloned
    // with the negative top-left offset so the region lands at the canvas
    // origin.
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1 })
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 2 })
    expect(page.render).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { scale: 2, offsetX: -120, offsetY: -40 } }),
    )
  })

  it('returns false when the render rejects', async () => {
    const page = pageMock()
    page.render.mockImplementation(() => ({ promise: Promise.reject(new Error('gone')) }))
    expect(
      await renderRegion(page as never, [0.2, 0.1, 0.6, 0.4], document.createElement('canvas'), 2),
    ).toBe(false)
  })
})

describe('canvasToPngBlob', () => {
  it('encodes a canvas as a PNG blob', async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 4
    canvas.getContext('2d')?.fillRect(0, 0, 4, 4)

    const blob = await canvasToPngBlob(canvas)
    expect(blob).not.toBeNull()
    expect(blob?.type).toBe('image/png')
    expect(blob?.size ?? 0).toBeGreaterThan(0)
  })
})

describe('copyBorderReference', () => {
  function deps(overrides: Partial<Parameters<typeof copyBorderReference>[2]> = {}) {
    return {
      doc: { getPage: vi.fn(async () => pageMock()) } as never,
      saveFile: vi.fn(async () => 'assets/pasted-123.png'),
      writeClipboard: vi.fn(async () => {}),
      ...overrides,
    }
  }

  it('copies a linked screenshot for a border annotation', async () => {
    const saveFile = vi.fn(async (_file: File) => 'assets/pasted-123.png')
    const writeClipboard = vi.fn(async () => {})
    const outcome = await copyBorderReference('assets/paper.pdf', item({}), {
      doc: { getPage: vi.fn(async () => pageMock()) } as never,
      saveFile,
      writeClipboard,
    })

    expect(outcome).toBe('copied-screenshot')
    expect(saveFile).toHaveBeenCalledTimes(1)
    const file = saveFile.mock.calls[0]?.[0] as File
    expect(file.type).toBe('image/png')
    expect(writeClipboard).toHaveBeenCalledWith(
      '[![pasted-123.png](assets/pasted-123.png)](assets/paper.pdf#page=3)',
    )
  })

  it('falls back to the text link when no document is available', async () => {
    const writeClipboard = vi.fn(async () => {})
    const outcome = await copyBorderReference('assets/paper.pdf', item({}), {
      ...deps({ doc: null }),
      writeClipboard,
    })

    expect(outcome).toBe('copied-text')
    expect(writeClipboard).toHaveBeenCalledWith('[paper - p3](assets/paper.pdf#page=3)')
  })

  it('falls back to the text link when the asset save fails', async () => {
    const writeClipboard = vi.fn(async () => {})
    const outcome = await copyBorderReference('assets/paper.pdf', item({}), {
      ...deps({ saveFile: vi.fn(async () => null) }),
      writeClipboard,
    })

    expect(outcome).toBe('copied-text')
  })
})
