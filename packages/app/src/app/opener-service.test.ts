import { describe, expect, it, vi } from 'vitest'
import { createTestLoggerService } from '@reflect/core/testing'
import { createOpenerService, type OpenerTransport } from './opener-service.ts'

function serviceOver(transport: Partial<OpenerTransport>) {
  const logger = createTestLoggerService()
  const opener = createOpenerService({
    transport: {
      openUrl: transport.openUrl ?? (async () => {}),
      revealItemInDir: transport.revealItemInDir ?? (async () => {}),
    },
    logger,
  })
  return { opener, logger }
}

describe('createOpenerService', () => {
  it('forwards urls and paths to the transport', async () => {
    const openUrl = vi.fn(async () => {})
    const revealItemInDir = vi.fn(async () => {})
    const { opener } = serviceOver({ openUrl, revealItemInDir })

    await opener.openUrl('https://example.com')
    opener.openUrlSync('https://reflect.app')
    await opener.revealInFileManager('/g')

    expect(openUrl.mock.calls).toEqual([['https://example.com'], ['https://reflect.app']])
    expect(revealItemInDir).toHaveBeenCalledWith('/g')
  })

  it('logs instead of rejecting when a fire-and-forget open fails', async () => {
    const { opener, logger } = serviceOver({
      openUrl: () => Promise.reject(new Error('no handler')),
    })

    expect(() => opener.openUrlSync('https://example.com')).not.toThrow()
    await vi.waitFor(() =>
      expect(logger.getErrors()).toEqual([
        { message: 'failed to open https://example.com:', cause: 'no handler' },
      ]),
    )
  })

  it('opens the macOS privacy panes', () => {
    const openUrl = vi.fn(async () => {})
    const { opener } = serviceOver({ openUrl })

    opener.openSystemSettings('calendar')
    opener.openSystemSettings('contacts')

    expect(openUrl.mock.calls).toEqual([
      ['x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'],
      ['x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts'],
    ])
  })
})
