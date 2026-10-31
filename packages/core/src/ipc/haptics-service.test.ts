import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createHapticsService } from './haptics-service.ts'

describe('HapticsService', () => {
  it('fires the plugin impact command on every call while the plugin answers', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.onCommand('plugin:mobile-haptics|impact_light', () => null)
    const haptics = createHapticsService({ ipc, logger: createTestLoggerService() })

    await haptics.impactLight()
    await haptics.impactLight()

    expect(ipc.calls()).toEqual([
      { command: 'plugin:mobile-haptics|impact_light', args: {} },
      { command: 'plugin:mobile-haptics|impact_light', args: {} },
    ])
  })

  it('warns once and stops invoking after the plugin rejects', async () => {
    const ipc = createTestIpcBridgeService()
    const logger = createTestLoggerService()
    const haptics = createHapticsService({ ipc, logger })

    // Two calls with both invokes in flight: only the first rejection warns.
    await Promise.all([haptics.impactLight(), haptics.impactLight()])
    expect(ipc.calls()).toHaveLength(2)
    expect(logger.getWarnings().map((entry) => entry.message)).toEqual(['haptics unavailable'])

    await haptics.impactLight()
    expect(ipc.calls()).toHaveLength(2)
    expect(logger.getWarnings()).toHaveLength(1)
  })

  it('keeps the failure latch per instance', async () => {
    const ipc = createTestIpcBridgeService()
    const logger = createTestLoggerService()
    await createHapticsService({ ipc, logger }).impactLight()

    ipc.onCommand('plugin:mobile-haptics|impact_light', () => null)
    await createHapticsService({ ipc, logger }).impactLight()

    expect(ipc.calls()).toHaveLength(2)
  })
})
