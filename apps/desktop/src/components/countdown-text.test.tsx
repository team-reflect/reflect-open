import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { CountdownText } from './countdown-text.tsx'

describe('CountdownText', () => {
  it('counts down by minutes, then by seconds, and stops at zero', async () => {
    const { core } = await renderInApp(
      <span data-testid="countdown">
        <CountdownText until={2 * 60_000} />
      </span>,
    )
    const countdown = page.getByTestId('countdown')
    await expect.element(countdown).toHaveTextContent('2 minutes')

    await act(() => core.clock.advance(1))
    await expect.element(countdown).toHaveTextContent('1 minute')

    await act(() => core.clock.advance(60_000))
    await expect.element(countdown).toHaveTextContent('59 seconds')

    await act(() => core.clock.advance(58_999))
    await expect.element(countdown).toHaveTextContent('1 second')

    await act(() => core.clock.advance(1_001))
    await expect.element(countdown).toHaveTextContent('0 seconds')
    expect(core.clock.pendingTimers()).toBe(0)
  })
})
