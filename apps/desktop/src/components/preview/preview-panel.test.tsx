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
vi.mock('@/lib/annotations/annotations-store', () => ({
  usePdfAnnotations: () => ({
    annotations: [],
    status: 'ready',
    addAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
  }),
}))
vi.mock('@/providers/pdf-session-provider', () => ({
  usePdfSession: () => ({
    session: { viewer: null, pdfDocument: null, assetPath: null },
    register: vi.fn(),
    clear: vi.fn(),
  }),
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

async function renderPdfPreview() {
  return await render(
    <PreviewPanel target={{ kind: 'pdf', assetPath: 'assets/paper.pdf' }} onClose={vi.fn()} />,
  )
}

afterEach(() => {
  document.querySelectorAll('input.temp-preview-key').forEach((el) => el.remove())
  document.body.blur()
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
})
