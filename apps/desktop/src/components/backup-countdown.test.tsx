import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { actAsync } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { BackupCountdown } from './backup-countdown.tsx'

describe('BackupCountdown', () => {
  it('counts down by minutes, then by seconds, and stops at zero', async () => {
    const { app } = await renderInApp(
      <span data-testid="countdown">
        <BackupCountdown until={2 * 60_000} />
      </span>,
    )
    const countdown = page.getByTestId('countdown')
    await expect.element(countdown).toHaveTextContent('2 minutes')

    await actAsync(() => app.clock.advance(1))
    await expect.element(countdown).toHaveTextContent('1 minute')

    await actAsync(() => app.clock.advance(60_000))
    await expect.element(countdown).toHaveTextContent('59 seconds')

    await actAsync(() => app.clock.advance(58_999))
    await expect.element(countdown).toHaveTextContent('1 second')

    await actAsync(() => app.clock.advance(1_001))
    await expect.element(countdown).toHaveTextContent('0 seconds')
    expect(app.clock.pendingTimers()).toBe(0)
  })
})
