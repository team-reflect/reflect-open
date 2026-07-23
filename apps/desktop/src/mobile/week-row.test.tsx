import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator'
import { WeekRow } from './week-row'

const hapticImpactLight = vi.hoisted(() => vi.fn())

vi.mock('@/mobile/haptics', () => ({ hapticImpactLight }))

afterEach(async () => {
  await cleanup()
  hapticImpactLight.mockReset()
})

describe('WeekRow', () => {
  it('keeps a daily note marked when the date is both selected and today', async () => {
    const onSelect = vi.fn()
    await render(
      <WeekRow
        weekStart="2026-07-13"
        selectedDay="2026-07-16"
        todayDay="2026-07-16"
        dailyNoteDates={new Set(['2026-07-13', '2026-07-16'])}
        onSelect={onSelect}
      />,
    )

    const selected = page.getByRole('button', {
      name: 'Thursday, July 16th, has daily note',
    })
    await expect.element(selected).toHaveAttribute('aria-current', 'date')
    await expect.element(page.getByTestId('note-dot-2026-07-16')).toBeVisible()
    await expect.element(page.getByTestId('note-dot-2026-07-13')).toBeVisible()
    await expect.element(page.getByTestId('note-dot-2026-07-14')).not.toBeInTheDocument()

    await userEvent.click(selected)
    expect(hapticImpactLight).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('2026-07-16')
  })
})
