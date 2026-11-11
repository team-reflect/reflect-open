import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WeekRow } from './week-row.tsx'

describe('WeekRow', () => {
  it('keeps a daily note marked when the date is both selected and today', async () => {
    const onSelect = vi.fn()
    const { core } = await renderInApp(
      <WeekRow
        weekStart="2026-07-13"
        selectedDay="2026-07-16"
        todayDay="2026-07-16"
        dailyNoteDates={new Set(['2026-07-13', '2026-07-16'])}
        onSelect={onSelect}
      />,
    )

    const selected = page.getByRole('button', {
      name: 'Thu, July 16th, 2026, has daily note',
    })
    await expect.element(selected).toHaveAttribute('aria-current', 'date')
    await expect.element(page.getByTestId('note-dot-2026-07-16')).toBeVisible()
    await expect.element(page.getByTestId('note-dot-2026-07-13')).toBeVisible()
    await expect.element(page.getByTestId('note-dot-2026-07-14')).not.toBeInTheDocument()

    await userEvent.click(selected)
    expect(core.mobile.haptics.impacts()).toBe(1)
    expect(onSelect).toHaveBeenCalledWith('2026-07-16')
  })
})
