import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it } from 'vitest'
import { SidebarSection } from './sidebar-section'

function renderSection() {
  return render(
    <SidebarSection storageKey="probe" title="Probe">
      <p>section body</p>
    </SidebarSection>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('SidebarSection', () => {
  it('is open by default with an expanded header', async () => {
    const view = await renderSection()
    await expect
      .element(view.getByRole('button', { name: /Probe/ }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByText('section body')).toBeInTheDocument()
    await view.unmount()
  })

  it('collapses on header click, unmounting the children', async () => {
    const view = await renderSection()
    const header = view.getByRole('button', { name: /Probe/ })
    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    expect(view.getByText('section body').query()).toBeNull()
    expect(window.sessionStorage.getItem('reflect.context-sidebar.probe')).toBe('closed')
    await view.unmount()
  })

  it('stays collapsed across a remount via sessionStorage', async () => {
    const collapsed = await renderSection()
    await userEvent.click(collapsed.getByRole('button', { name: /Probe/ }))
    await collapsed.unmount()

    const remounted = await renderSection()
    await expect
      .element(remounted.getByRole('button', { name: /Probe/ }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(remounted.getByText('section body').query()).toBeNull()
    await remounted.unmount()
  })

  it('persists reopening so the next mount starts open again', async () => {
    window.sessionStorage.setItem('reflect.context-sidebar.probe', 'closed')
    const view = await renderSection()
    const header = view.getByRole('button', { name: /Probe/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByText('section body')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('reflect.context-sidebar.probe')).toBe('open')
    await view.unmount()

    const remounted = await renderSection()
    await expect
      .element(remounted.getByRole('button', { name: /Probe/ }))
      .toHaveAttribute('aria-expanded', 'true')
    await remounted.unmount()
  })
})
