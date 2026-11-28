import { describe, expect, it, vi } from 'vitest'
import { noop, returnNull } from '@ocavue/utils'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestPlatformService } from '../testing/platform.ts'
import { createScreenService } from './screen-service.ts'

function setup(appPlatform: 'ios' | 'desktop') {
  const ipc = createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const screen = createScreenService({
    ipc,
    platform: createTestPlatformService({ appPlatform }),
    logger,
  })
  const sent = (): unknown[] => {
    return ipc
      .calls()
      .filter((call) => call.command === 'plugin:screen|keep_awake')
      .map((call) => call.args)
  }
  return { ipc, logger, screen, sent }
}

describe('ScreenService', () => {
  it('asks the shell once for nested holds and once to let go', async () => {
    const { ipc, screen, sent } = setup('ios')
    ipc.onCommand('plugin:screen|keep_awake', returnNull)

    const first = screen.keepAwake()
    const second = screen.keepAwake()
    first()
    first()
    await vi.waitFor(() => expect(sent()).toHaveLength(1))
    second()

    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    expect(sent()).toEqual([{ keepAwake: true }, { keepAwake: false }])
  })

  it('logs a failed send', async () => {
    const { logger, screen } = setup('ios')

    screen.keepAwake()

    await vi.waitFor(() => expect(logger.getErrors()).toHaveLength(1))
  })

  it('sends nothing on desktop', () => {
    const { screen, sent } = setup('desktop')

    expect(screen.keepAwake()).toBe(noop)
    expect(sent()).toEqual([])
  })
})
