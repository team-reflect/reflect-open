import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { usePdfSidebarView, PdfSidebarViewProvider } from './pdf-sidebar-view-provider'

function Harness(): ReactElement {
  const { view, enterPdf, backToDocument, applyTarget } = usePdfSidebarView()
  return (
    <div>
      <span data-testid="view">{view}</span>
      <button type="button" onClick={() => applyTarget(true)}>
        target-on
      </button>
      <button type="button" onClick={() => applyTarget(false)}>
        target-off
      </button>
      <button type="button" onClick={enterPdf}>
        enter
      </button>
      <button type="button" onClick={backToDocument}>
        back
      </button>
    </div>
  )
}

function renderHarness() {
  return render(
    <PdfSidebarViewProvider>
      <Harness />
    </PdfSidebarViewProvider>,
  )
}

function view(): string {
  return page.getByTestId('view').element()?.textContent ?? ''
}

describe('PdfSidebarViewProvider', () => {
  it('starts on the document panel and edge-toggles with the target', async () => {
    const harness = await renderHarness()
    expect(view()).toBe('document')

    // PDF 打开（false→true）：自动推到 PDF 面板。
    await page.getByRole('button', { name: 'target-on' }).click()
    await expect.poll(() => view()).toBe('pdf')

    // PDF 关闭（true→false）：自动弹回文档面板。
    await page.getByRole('button', { name: 'target-off' }).click()
    await expect.poll(() => view()).toBe('document')
    await harness.unmount()
  })

  it('never overrides a manual view while the target state is steady', async () => {
    await renderHarness()

    // 打开 PDF → 自动进 PDF 面板；用户手动返回文档面板。
    await page.getByRole('button', { name: 'target-on' }).click()
    await expect.poll(() => view()).toBe('pdf')
    await page.getByRole('button', { name: 'back' }).click()
    await expect.poll(() => view()).toBe('document')

    // 目标状态不变时重放 applyTarget(true)：不是边缘变化，保持文档面板。
    await page.getByRole('button', { name: 'target-on' }).click()
    expect(view()).toBe('document')

    // 手动 enterPdf 仍然有效，且不因重放被覆盖。
    await page.getByRole('button', { name: 'enter' }).click()
    await expect.poll(() => view()).toBe('pdf')
    await page.getByRole('button', { name: 'target-on' }).click()
    expect(view()).toBe('pdf')
  })
})
