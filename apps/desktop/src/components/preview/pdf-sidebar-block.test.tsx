import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfSidebarBlock } from './pdf-sidebar-block'

const sessionState = vi.hoisted(() => {
  const viewer = { currentPageNumber: 1 } as { currentPageNumber: number }
  const pdfDocument = {
    numPages: 2,
    getOutline: vi.fn(async () => [
      {
        title: 'Introduction',
        bold: true,
        italic: false,
        color: null,
        dest: 'introDest',
        items: [],
      },
      {
        title: 'Chapter 1',
        bold: false,
        italic: false,
        color: null,
        dest: null,
        items: [
          { title: 'Section 1.1', bold: false, italic: false, color: null, dest: [{}], items: [] },
        ],
      },
    ]),
    getDestination: vi.fn(async (name: string) => {
      if (name === 'introDest') {
        return [{ num: 5, gen: 0 }]
      }
      return null
    }),
    getPageIndex: vi.fn(async () => 4),
    getPage: vi.fn(async () => ({
      getViewport: (options: { scale: number }) => ({
        width: 300 * options.scale,
        height: 200 * options.scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    })),
  }
  return { session: { viewer, pdfDocument, assetPath: 'assets/test.pdf' } }
})

const sidebarViewState = vi.hoisted(() => ({
  view: 'pdf' as 'document' | 'pdf',
  enterPdf: vi.fn(),
  backToDocument: vi.fn(),
  applyTarget: vi.fn(),
}))

vi.mock('@/providers/pdf-session-provider', () => ({
  usePdfSession: () => ({ session: sessionState.session, register: vi.fn(), clear: vi.fn() }),
}))
vi.mock('@/providers/pdf-sidebar-view-provider', () => ({
  usePdfSidebarView: () => sidebarViewState,
}))

beforeEach(() => {
  window.sessionStorage.clear()
  sidebarViewState.backToDocument.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('PdfSidebarBlock', () => {
  it('renders nothing until a session matches the target asset', async () => {
    const view = await render(<PdfSidebarBlock assetPath="assets/other.pdf" />)
    expect(page.getByLabelText('PDF test').query()).toBeNull()

    await view.rerender(<PdfSidebarBlock assetPath="assets/test.pdf" />)
    await expect.element(page.getByLabelText('PDF test')).toBeInTheDocument()
    await expect.element(page.getByText('test', { exact: true })).toBeInTheDocument()
  })

  it('opens with Outline expanded and Pages collapsed, and the back action works', async () => {
    await render(<PdfSidebarBlock assetPath="assets/test.pdf" />)

    // 三个区头都在（PDF actions 用 SidebarSection，Outline/Pages 用预设变体）。
    await expect.element(page.getByRole('button', { name: /PDF actions/ })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /Outline/ })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /Pages/ })).toBeInTheDocument()

    // 默认仅 Outline 展开：目录树可见、缩略图不可见。
    await expect.element(page.getByText('Introduction')).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Page 1' }).query()).toBeNull()
    await expect
      .element(page.getByRole('button', { name: /Outline/ }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect
      .element(page.getByRole('button', { name: /Pages/ }))
      .toHaveAttribute('aria-expanded', 'false')

    // PDF actions 的返回按钮。
    await page.getByRole('button', { name: 'Back to document' }).click()
    expect(sidebarViewState.backToDocument).toHaveBeenCalledTimes(1)
  })

  it('toggles each section and resets to the Outline-only preset on remount', async () => {
    const view = await render(<PdfSidebarBlock assetPath="assets/test.pdf" />)

    // 展开 Pages：缩略图出现；折叠 Outline：目录树消失。
    await page.getByRole('button', { name: /Pages/ }).click()
    await expect
      .element(page.getByRole('button', { name: /Pages/ }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByRole('button', { name: 'Page 1' })).toBeInTheDocument()

    await page.getByRole('button', { name: /Outline/ }).click()
    await expect
      .element(page.getByRole('button', { name: /Outline/ }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(page.getByText('Introduction').query()).toBeNull()

    // 重新打开（重挂）：回到「仅 Outline 展开」的阅读预设，不残留上次切换。
    await view.unmount()
    await render(<PdfSidebarBlock assetPath="assets/test.pdf" />)
    await expect
      .element(page.getByRole('button', { name: /Outline/ }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect
      .element(page.getByRole('button', { name: /Pages/ }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('fills the sidebar height with the outline content taking most of it', async () => {
    await render(
      <div className="h-[600px] w-80">
        <PdfSidebarBlock assetPath="assets/test.pdf" />
      </div>,
    )
    const section = page.getByLabelText('PDF test').element()
    if (section === null) {
      throw new Error('section missing')
    }
    // h-full：面板高度 = 容器高度。
    expect(section.getBoundingClientRect().height).toBeGreaterThanOrEqual(599)

    // 默认仅 Outline 展开：其内容区（内部滚动）占面板大部分。
    const outlineScroll = section.querySelector('.overflow-y-auto')
    expect(outlineScroll).not.toBeNull()
    const outlineHeight = outlineScroll?.getBoundingClientRect().height ?? 0
    const sectionHeight = section.getBoundingClientRect().height
    expect(outlineHeight).toBeGreaterThan(sectionHeight * 0.6)

    // 临时控件用柔和的 accent 洗色标识（区别于永久上下文的 surface-sunken）。
    expect(section.className).toContain('bg-accent')
  })

  it('renders the outline tree and jumps the viewer on a click', async () => {
    await render(<PdfSidebarBlock assetPath="assets/test.pdf" />)
    await expect.element(page.getByText('Introduction')).toBeInTheDocument()
    await expect.element(page.getByText('Chapter 1')).toBeInTheDocument()
    await expect.element(page.getByText('Section 1.1')).toBeInTheDocument()

    // 命名的目标先经 getDestination 再经 getPageIndex 解析为 1 基页 5。
    await page.getByText('Introduction').click()
    await expect.poll(() => sessionState.session.viewer.currentPageNumber).toBe(5)
    expect(sessionState.session.pdfDocument.getDestination).toHaveBeenCalledWith('introDest')
    expect(sessionState.session.pdfDocument.getPageIndex).toHaveBeenCalledWith({ num: 5, gen: 0 })

    // 无 dest 的书签按钮禁用，点击不跳页。
    const chapter = page.getByRole('button', { name: 'Chapter 1' }).element()
    expect(chapter?.getAttribute('disabled')).not.toBeNull()
  })

  it('renders one clickable thumbnail per page and jumps on a click', async () => {
    await render(<PdfSidebarBlock assetPath="assets/test.pdf" />)

    // Pages 默认折叠，先展开再点缩略图。
    await page.getByRole('button', { name: /Pages/ }).click()
    await page.getByRole('button', { name: 'Page 2' }).click()
    expect(sessionState.session.viewer.currentPageNumber).toBe(2)
    expect(sessionState.session.pdfDocument.getPage).toHaveBeenCalled()
  })
})
