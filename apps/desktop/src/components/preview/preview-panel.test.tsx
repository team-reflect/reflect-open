import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PreviewPanel } from './preview-panel'

// The shortcut logic lives in PdfPreview and needs no pdf.js shell: pass
// children through and provide a no-op usePdfViewer (HighlightLayer /
// AnnotationList consume it).
vi.mock('./pdf-viewer-shell', () => ({
  PdfViewerShell: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  usePdfViewer: () => ({
    viewer: null,
    ready: false,
    currentPage: 1,
    pageCount: 1,
    scaleValue: '',
    zoomPercent: 100,
    error: null,
    goToPage: () => {},
    zoomBy: () => {},
    setScalePreset: () => {},
  }),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
const annotationsState = vi.hoisted(() => ({
  addAnnotation: vi.fn(),
  removeAnnotation: vi.fn(),
}))
const sessionState = vi.hoisted(() => ({
  session: {
    viewer: null,
    // The text-highlight capture reads pdf.js's own text coordinates; each
    // page's text content is its page number's word.
    pdfDocument: {
      getPage: vi.fn(async (pageNumber: number) => ({
        getTextContent: async () => ({
          items: [
            {
              str: pageNumber === 1 ? 'Some selected words' : 'Second page words',
              transform: [1, 0, 0, 1, 15, 180],
              width: 280,
              height: 12,
              hasEOL: false,
            },
          ],
        }),
        getViewport: () => ({
          width: 300,
          height: 200,
          convertToViewportRectangle: (r: number[]) => [
            r[0] ?? 0,
            200 - (r[3] ?? 0),
            r[2] ?? 0,
            200 - (r[1] ?? 0),
          ],
        }),
      })),
    },
    assetPath: null,
  },
  register: vi.fn(),
  clear: vi.fn(),
}))
vi.mock('@/lib/annotations/annotations-store', () => ({
  usePdfAnnotations: () => ({
    annotations: [],
    status: 'ready',
    addAnnotation: annotationsState.addAnnotation,
    updateAnnotation: vi.fn(),
    removeAnnotation: annotationsState.removeAnnotation,
  }),
}))
vi.mock('@/providers/pdf-session-provider', () => ({
  usePdfSession: () => sessionState,
}))
// The annotation list's height resize reads settings.
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { annotationListHeight: 180 },
    updateSettings: vi.fn(),
    updateSettingsWith: vi.fn(),
  }),
}))

function browsePressed(): string | null {
  return (
    page.getByRole('button', { name: 'Browse' }).element()?.getAttribute('aria-pressed') ?? null
  )
}

function drawPressed(): string | null {
  return (
    page.getByRole('button', { name: 'Draw rectangle' }).element()?.getAttribute('aria-pressed') ??
    null
  )
}

function highlightPressed(): string | null {
  return (
    page.getByRole('button', { name: 'Highlight text' }).element()?.getAttribute('aria-pressed') ??
    null
  )
}

async function renderPdfPreview() {
  return await render(
    <PreviewPanel target={{ kind: 'pdf', assetPath: 'assets/paper.pdf' }} onClose={vi.fn()} />,
  )
}

afterEach(() => {
  document.querySelectorAll('input.temp-preview-key').forEach((el) => el.remove())
  document.querySelectorAll('.temp-preview-page').forEach((el) => el.remove())
  window.getSelection()?.removeAllRanges()
  document.body.blur()
  annotationsState.addAnnotation.mockClear()
  annotationsState.removeAnnotation.mockClear()
})

describe('PdfPreview annotation-mode shortcuts', () => {
  it('switches modes with v and r, idempotently', async () => {
    await renderPdfPreview()
    await expect.poll(() => browsePressed()).toBe('true')

    await userEvent.keyboard('r')
    await expect.poll(() => drawPressed()).toBe('true')
    expect(browsePressed()).toBe('false')

    // Idempotent: re-pressing the active mode's key keeps the mode.
    await userEvent.keyboard('r')
    await expect.poll(() => drawPressed()).toBe('true')

    await userEvent.keyboard('v')
    await expect.poll(() => browsePressed()).toBe('true')
    expect(drawPressed()).toBe('false')
  })

  it('Escape in create mode returns to browse', async () => {
    await renderPdfPreview()
    await userEvent.keyboard('r')
    await expect.poll(() => drawPressed()).toBe('true')

    await userEvent.keyboard('{Escape}')
    await expect.poll(() => browsePressed()).toBe('true')
  })

  it('ignores the shortcuts while an editable target is focused', async () => {
    await renderPdfPreview()
    await expect.poll(() => browsePressed()).toBe('true')

    // Focus sits on an input (a page-number field / form): r / v / ESC do nothing.
    const input = document.createElement('input')
    input.className = 'temp-preview-key'
    document.body.append(input)
    input.focus()

    await userEvent.keyboard('r')
    expect(drawPressed()).toBe('false')
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => browsePressed()).toBe('true')
    await userEvent.keyboard('v')
    expect(browsePressed()).toBe('true')

    // The shortcuts resume once focus leaves the input.
    input.remove()
    await userEvent.keyboard('r')
    await expect.poll(() => drawPressed()).toBe('true')
  })

  it('blurs the focused toolbar button after a mode shortcut', async () => {
    await renderPdfPreview()
    const browse = page.getByRole('button', { name: 'Browse' }).element()
    browse?.focus()
    expect(document.activeElement).toBe(browse)

    // After r switches to create, the focus ring clears from the toolbar
    // button (focus returns to the reader context).
    await userEvent.keyboard('r')
    await expect.poll(() => drawPressed()).toBe('true')
    await expect.poll(() => document.activeElement).not.toBe(browse)

    // ESC back to browse clears the focus ring too.
    const draw = page.getByRole('button', { name: 'Draw rectangle' }).element()
    draw?.focus()
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => browsePressed()).toBe('true')
    await expect.poll(() => document.activeElement).not.toBe(draw)
  })

  it('switches to highlight with t and back with v or ESC', async () => {
    await renderPdfPreview()
    await expect.poll(() => browsePressed()).toBe('true')

    await userEvent.keyboard('t')
    await expect.poll(() => highlightPressed()).toBe('true')
    expect(browsePressed()).toBe('false')

    await userEvent.keyboard('v')
    await expect.poll(() => browsePressed()).toBe('true')
    expect(highlightPressed()).toBe('false')

    await userEvent.keyboard('t')
    await expect.poll(() => highlightPressed()).toBe('true')
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => browsePressed()).toBe('true')
  })

  it('creates a text annotation from a selection inside a pdf page on mouseup', async () => {
    await renderPdfPreview()
    await userEvent.keyboard('t')
    await expect.poll(() => highlightPressed()).toBe('true')
    // Let the mode-change effect re-bind the mouseup listener before firing it.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A fake pdf `.page` with a span, mirroring pdf.js's DOM shape. The app's
    // global CSS is `user-select: none`, so the span must opt back in for the
    // selection to carry text (the real textLayer spans are whitelisted).
    const pageEl = document.createElement('div')
    pageEl.className = 'page temp-preview-page'
    pageEl.setAttribute('data-page-number', '3')
    pageEl.style.width = '300px'
    pageEl.style.height = '300px'
    pageEl.style.position = 'absolute'
    pageEl.style.left = '100px'
    pageEl.style.top = '100px'
    document.body.append(pageEl)
    const span = document.createElement('span')
    span.textContent = 'Some selected words'
    span.style.userSelect = 'text'
    pageEl.append(span)

    const range = document.createRange()
    range.selectNodeContents(span)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    // The capture reads pdf.js's text content asynchronously.
    await vi.waitFor(() => expect(annotationsState.addAnnotation).toHaveBeenCalledTimes(1))
    const created = annotationsState.addAnnotation.mock.calls[0]?.[0] as
      | {
          pageIndex: number
          type: string
          rects: number[][]
          text: string
          color: string
        }
      | undefined
    expect(created).toBeDefined()
    if (created === undefined) {
      return
    }
    expect(created.pageIndex).toBe(2)
    expect(created.type).toBe('text')
    expect(created.text).toBe('Some selected words')
    expect(created.color).toBe('#FFD400')
    expect(created.rects.length).toBeGreaterThan(0)
    for (const rect of created.rects) {
      expect(rect).toHaveLength(4)
      for (const value of rect) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it('does not create an annotation from a collapsed or out-of-page selection', async () => {
    await renderPdfPreview()
    await userEvent.keyboard('t')
    await expect.poll(() => highlightPressed()).toBe('true')

    // No selection at all.
    window.getSelection()?.removeAllRanges()
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(annotationsState.addAnnotation).not.toHaveBeenCalled()

    // A selection outside any `.page` (a plain div).
    const plain = document.createElement('div')
    plain.className = 'temp-preview-page'
    document.body.append(plain)
    const span = document.createElement('span')
    span.textContent = 'editor text'
    plain.append(span)
    const range = document.createRange()
    range.selectNodeContents(span)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(annotationsState.addAnnotation).not.toHaveBeenCalled()
  })

  it('creates one annotation per page for a cross-page selection', async () => {
    await renderPdfPreview()
    await userEvent.keyboard('t')
    await expect.poll(() => highlightPressed()).toBe('true')
    // Let the mode-change effect re-bind the mouseup listener before firing it.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Two stacked fake pdf pages, each with a text layer (the per-page text is
    // sliced from the text layer) and a selectable span.
    const viewer = document.createElement('div')
    viewer.className = 'pdfViewer temp-preview-page'
    document.body.append(viewer)
    const pages = [1, 2].map((n) => {
      const pageEl = document.createElement('div')
      pageEl.className = 'page'
      pageEl.setAttribute('data-page-number', String(n))
      pageEl.style.width = '300px'
      pageEl.style.height = '300px'
      pageEl.style.position = 'absolute'
      pageEl.style.top = `${(n - 1) * 320}px`
      const textLayer = document.createElement('div')
      textLayer.className = 'textLayer'
      const span = document.createElement('span')
      span.textContent = n === 1 ? 'First page words' : 'Second page words'
      span.style.userSelect = 'text'
      textLayer.append(span)
      pageEl.append(textLayer)
      viewer.append(pageEl)
      return { pageEl, textLayer, span }
    })

    // Select from page 1's span through page 2's span.
    const firstText = pages[0]!.span.firstChild!
    const secondText = pages[1]!.span.firstChild!
    const range = document.createRange()
    range.setStart(firstText, 0)
    range.setEnd(secondText, 6)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

    await vi.waitFor(() => expect(annotationsState.addAnnotation).toHaveBeenCalledTimes(2))
    const calls = annotationsState.addAnnotation.mock.calls
    const byPage = new Map<number, { text: string; type: string }>()
    for (const call of calls) {
      const payload = call[0] as { pageIndex: number; text: string; type: string }
      byPage.set(payload.pageIndex, { text: payload.text, type: payload.type })
    }
    expect(byPage.get(0)?.type).toBe('text')
    expect(byPage.get(0)?.text).toBe('First page words')
    expect(byPage.get(1)?.text).toBe('Second')
  })
})
