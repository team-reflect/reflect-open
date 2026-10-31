import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { useWakeToToday } from './use-wake-to-today.ts'

/**
 * V1's wake-to-today: foregrounding the app on a later calendar date than it
 * was backgrounded on navigates to today; a same-day foreground stays put.
 * Visibility comes from the test lifecycle service and the date from the test
 * clock.
 */

function Probe(): ReactElement {
  useWakeToToday()
  const { route } = useRouter()
  return <output>{route.kind === 'daily' ? `daily:${route.date}` : route.kind}</output>
}

async function mountOn(date: string) {
  const view = await renderInApp(<Probe />, { route: { kind: 'daily', date } })
  view.core.clock.setNow(new Date(2026, 5, 12, 22, 0, 0).getTime()) // 2026-06-12, late evening
  return view
}

describe('useWakeToToday', () => {
  it('navigates to today when the app foregrounds on a new date', async () => {
    const view = await mountOn('2026-06-10')
    await expect.element(view.getByRole('status')).toMatchTextContent('daily:2026-06-10')

    view.core.activity.emitHidden()
    view.core.clock.setNow(new Date(2026, 5, 13, 8, 0, 0).getTime()) // overnight in the background
    view.core.activity.emitVisible()

    await expect.element(view.getByRole('status')).toMatchTextContent('today')
  })

  it('stays put when the app foregrounds on the same date', async () => {
    const view = await mountOn('2026-06-10')

    view.core.activity.emitHidden()
    view.core.clock.setNow(new Date(2026, 5, 12, 23, 30, 0).getTime()) // later the same evening
    view.core.activity.emitVisible()

    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect.element(view.getByRole('status')).toMatchTextContent('daily:2026-06-10')
  })
})
