import { describe, expect, it } from 'vitest'
import { computePaywallBlocker } from './paywall-blocker.ts'

const SETTLED = { value: null, active: false, isLoading: false }

describe('computePaywallBlocker', () => {
  it('blocks while the paywall shows', () => {
    expect(computePaywallBlocker('skippable', SETTLED, SETTLED, SETTLED)).toBe('blocked')
    expect(computePaywallBlocker('required', SETTLED, SETTLED, SETTLED)).toBe('blocked')
  })

  it('clears a subscriber or a Reflect Classic member without waiting', () => {
    const loading = { ...SETTLED, isLoading: true }
    expect(computePaywallBlocker('hidden', { value: {}, isLoading: false }, loading, loading)).toBe(
      'clear',
    )
    expect(
      computePaywallBlocker('hidden', loading, { active: true, isLoading: false }, loading),
    ).toBe('clear')
  })

  it('waits until every check behind the paywall settles', () => {
    const loading = { ...SETTLED, isLoading: true }
    expect(computePaywallBlocker('hidden', loading, SETTLED, SETTLED)).toBe('pending')
    expect(computePaywallBlocker('hidden', SETTLED, loading, SETTLED)).toBe('pending')
    expect(computePaywallBlocker('hidden', SETTLED, SETTLED, loading)).toBe('pending')
    expect(computePaywallBlocker('hidden', SETTLED, SETTLED, SETTLED)).toBe('clear')
  })
})
