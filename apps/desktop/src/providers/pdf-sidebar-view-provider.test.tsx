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

    // Opening a PDF (false→true) auto-pushes the PDF panel on top.
    await page.getByRole('button', { name: 'target-on' }).click()
    await expect.poll(() => view()).toBe('pdf')

    // Closing it (true→false) auto-pops back to the document panel.
    await page.getByRole('button', { name: 'target-off' }).click()
    await expect.poll(() => view()).toBe('document')
    await harness.unmount()
  })

  it('never overrides a manual view while the target state is steady', async () => {
    await renderHarness()

    // Opening the PDF auto-enters the PDF panel; the user manually returns.
    await page.getByRole('button', { name: 'target-on' }).click()
    await expect.poll(() => view()).toBe('pdf')
    await page.getByRole('button', { name: 'back' }).click()
    await expect.poll(() => view()).toBe('document')

    // Replaying applyTarget(true) with a steady target is not an edge
    // change: the document panel stays.
    await page.getByRole('button', { name: 'target-on' }).click()
    expect(view()).toBe('document')

    // A manual enterPdf still works and is not overridden by the replay.
    await page.getByRole('button', { name: 'enter' }).click()
    await expect.poll(() => view()).toBe('pdf')
    await page.getByRole('button', { name: 'target-on' }).click()
    expect(view()).toBe('pdf')
  })
})
