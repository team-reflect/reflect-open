import { describe, expect, it } from 'vitest'
import { createTestHapticsService } from '@reflect/core/testing'
import { hapticImpactLight } from './haptics.ts'

describe('hapticImpactLight', () => {
  it('fires a light impact on every call', () => {
    const haptics = createTestHapticsService()

    hapticImpactLight(haptics)
    hapticImpactLight(haptics)

    expect(haptics.impacts()).toBe(2)
  })

  it('swallows a failing haptic engine', async () => {
    const failing = createTestHapticsService({ fail: true })

    hapticImpactLight(failing)
    await Promise.resolve()

    expect(failing.impacts()).toBe(1)
  })
})
