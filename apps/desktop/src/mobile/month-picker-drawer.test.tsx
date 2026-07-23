import type { ReactNode } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonthPickerDrawer } from './month-picker-drawer'

/**
 * The month title's picker sheet: a year pager over a twelve-month grid.
 * Year browsing must never navigate, each open must start from the header's
 * month, and the selection/today months carry the strip's markings.
 */

// vaul needs browser APIs jsdom doesn't provide (matchMedia, pointer
// capture); its drag/animation is verified on-device. This passthrough
// honours `open` so open/close behavior stays testable.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div data-testid="drawer">{children}</div> : null,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

afterEach(cleanup)

async function mount(overrides: Partial<Parameters<typeof MonthPickerDrawer>[0]> = {}) {
  const onPick = vi.fn()
  const view = await render(
    <MonthPickerDrawer
      open
      onOpenChange={() => {}}
      month="2026-06"
      selected="2026-06"
      today="2026-07"
      onPick={onPick}
      {...overrides}
    />,
  )
  return { view, onPick }
}

describe('MonthPickerDrawer', () => {
  it('opens on the header month’s year with the selection and today marked', async () => {
    await mount()

    await expect.element(page.getByText('2026')).toBeVisible()
    const months = page.getByRole('button', { name: /2026$/ }).elements()
    expect(months).toHaveLength(12)
    await expect
      .element(page.getByRole('button', { name: 'June 2026' }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect
      .element(page.getByRole('button', { name: 'July 2026' }))
      .toHaveAttribute('aria-current', 'date')
  })

  it('picks a month of the shown year', async () => {
    const { onPick } = await mount()

    await userEvent.click(page.getByRole('button', { name: 'September 2026' }))
    expect(onPick).toHaveBeenCalledWith('2026-09')
  })

  it('pages years without navigating, then picks in the browsed year', async () => {
    const { onPick } = await mount()

    await userEvent.click(page.getByRole('button', { name: 'Previous year' }))
    await userEvent.click(page.getByRole('button', { name: 'Previous year' }))
    await expect.element(page.getByText('2024')).toBeVisible()
    expect(onPick).not.toHaveBeenCalled()

    await userEvent.click(page.getByRole('button', { name: 'March 2024' }))
    expect(onPick).toHaveBeenCalledWith('2024-03')
  })

  it('reopens on the header month’s year, not the last browsed one', async () => {
    const { view } = await mount()

    await userEvent.click(page.getByRole('button', { name: 'Next year' }))
    await expect.element(page.getByText('2027')).toBeVisible()

    await view.rerender(
      <MonthPickerDrawer
        open={false}
        onOpenChange={() => {}}
        month="2026-06"
        selected="2026-06"
        today="2026-07"
        onPick={() => {}}
      />,
    )
    await expect.element(page.getByTestId('drawer')).not.toBeInTheDocument()

    await view.rerender(
      <MonthPickerDrawer
        open
        onOpenChange={() => {}}
        month="2026-06"
        selected="2026-06"
        today="2026-07"
        onPick={() => {}}
      />,
    )
    await expect.element(page.getByText('2026')).toBeVisible()
  })
})
