import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PreviewPanel } from './preview-panel'

// 快捷键逻辑在 PdfPreview 上，不依赖 pdf.js 外壳：透传 children 并提供
// usePdfViewer 的 no-op 值（HighlightLayer/AnnotationList 消费）。
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
// AnnotationSection 的清单高度 resize 读取设置。
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

    // 幂等：重复按当前模式的键保持该模式。
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

    // 焦点在 input 上（模拟页码输入框/表单）：r / v / ESC 都不生效。
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

    // 移开焦点后快捷键恢复。
    input.remove()
    await userEvent.keyboard('r')
    await expect.poll(() => drawPressed()).toBe('true')
  })

  it('blurs the focused toolbar button after a mode shortcut', async () => {
    await renderPdfPreview()
    const browse = page.getByRole('button', { name: 'Browse' }).element()
    browse?.focus()
    expect(document.activeElement).toBe(browse)

    // 按 r 切到 create 后，焦点环从工具栏按钮上清除（回到阅读器上下文）。
    await userEvent.keyboard('r')
    await expect.poll(() => drawPressed()).toBe('true')
    await expect.poll(() => document.activeElement).not.toBe(browse)

    // ESC 回 browse 同样清除焦点环。
    const draw = page.getByRole('button', { name: 'Draw rectangle' }).element()
    draw?.focus()
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => browsePressed()).toBe('true')
    await expect.poll(() => document.activeElement).not.toBe(draw)
  })
})
