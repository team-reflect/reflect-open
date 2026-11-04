import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  PAYWALL_HIDDEN_DAYS,
  PAYWALL_SKIPPABLE_DAYS,
  getPaywallDaysLeft,
  getPaywallPhase,
  getPaywallRequiredAt,
} from './paywall-phase.ts'

const SKIPPABLE_STARTS = PAYWALL_HIDDEN_DAYS * DAY_MS
const REQUIRED_STARTS = (PAYWALL_HIDDEN_DAYS + PAYWALL_SKIPPABLE_DAYS) * DAY_MS

describe('getPaywallPhase', () => {
  it('stays hidden until the hidden period ends', () => {
    expect(getPaywallPhase(0)).toBe('hidden')
    expect(getPaywallPhase(SKIPPABLE_STARTS - 1)).toBe('hidden')
  })

  it('is skippable until the skippable period ends', () => {
    expect(getPaywallPhase(SKIPPABLE_STARTS)).toBe('skippable')
    expect(getPaywallPhase(REQUIRED_STARTS - 1)).toBe('skippable')
  })

  it('is required afterwards', () => {
    expect(getPaywallPhase(REQUIRED_STARTS)).toBe('required')
    expect(getPaywallPhase(REQUIRED_STARTS * 10)).toBe('required')
  })
})

describe('getPaywallRequiredAt', () => {
  it('is the first launch plus both periods', () => {
    expect(getPaywallRequiredAt(1000)).toBe(1000 + REQUIRED_STARTS)
  })
})

describe('getPaywallDaysLeft', () => {
  it('rounds partial days up and stops at zero', () => {
    expect(getPaywallDaysLeft(0, 0)).toBe(PAYWALL_HIDDEN_DAYS + PAYWALL_SKIPPABLE_DAYS)
    expect(getPaywallDaysLeft(0, REQUIRED_STARTS - 1)).toBe(1)
    expect(getPaywallDaysLeft(0, REQUIRED_STARTS)).toBe(0)
    expect(getPaywallDaysLeft(0, REQUIRED_STARTS + DAY_MS)).toBe(0)
  })
})
