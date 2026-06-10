import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { SidebarSection } from './sidebar-section'

function renderSection(count?: number) {
  return render(
    <SidebarSection storageKey="probe" title="Probe" count={count}>
      <p>section body</p>
    </SidebarSection>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('SidebarSection', () => {
  it('is open by default with an expanded header', () => {
    const view = renderSection()
    expect(view.getByRole('button', { name: /Probe/ }).getAttribute('aria-expanded')).toBe(
      'true',
    )
    expect(view.getByText('section body')).toBeDefined()
    view.unmount()
  })

  it('collapses on header click, unmounting the children', async () => {
    const view = renderSection()
    const header = view.getByRole('button', { name: /Probe/ })
    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('section body')).toBeNull()
    expect(window.sessionStorage.getItem('reflect.context-sidebar.probe')).toBe('closed')
    view.unmount()
  })

  it('stays collapsed across a remount via sessionStorage', async () => {
    const collapsed = renderSection()
    await userEvent.click(collapsed.getByRole('button', { name: /Probe/ }))
    collapsed.unmount()

    const remounted = renderSection()
    expect(
      remounted.getByRole('button', { name: /Probe/ }).getAttribute('aria-expanded'),
    ).toBe('false')
    expect(remounted.queryByText('section body')).toBeNull()
    remounted.unmount()
  })

  it('persists reopening so the next mount starts open again', async () => {
    window.sessionStorage.setItem('reflect.context-sidebar.probe', 'closed')
    const view = renderSection()
    const header = view.getByRole('button', { name: /Probe/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')

    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('section body')).toBeDefined()
    expect(window.sessionStorage.getItem('reflect.context-sidebar.probe')).toBe('open')
    view.unmount()

    const remounted = renderSection()
    expect(
      remounted.getByRole('button', { name: /Probe/ }).getAttribute('aria-expanded'),
    ).toBe('true')
    remounted.unmount()
  })

  it('renders the count only when it is greater than zero', () => {
    const withCount = renderSection(4)
    expect(withCount.getByText('4')).toBeDefined()
    withCount.unmount()

    const zeroCount = renderSection(0)
    expect(zeroCount.queryByText('0')).toBeNull()
    zeroCount.unmount()

    const noCount = renderSection()
    expect(noCount.getByRole('button', { name: 'Probe' })).toBeDefined()
    noCount.unmount()
  })
})
