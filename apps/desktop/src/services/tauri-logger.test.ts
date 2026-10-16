import { afterEach, describe, expect, it, vi } from 'vitest'
import { error, info, warn } from '@tauri-apps/plugin-log'
import { createTestLoggerService } from '@reflect/core/testing'
import { createTauriLogger } from './tauri-logger.ts'

vi.mock('@tauri-apps/plugin-log', () => ({
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
}))
const pluginError = vi.mocked(error)
const pluginWarn = vi.mocked(warn)
const pluginInfo = vi.mocked(info)

afterEach(() => {
  vi.clearAllMocks()
})

describe('createTauriLogger', () => {
  it('passes each entry to the inner logger unchanged', () => {
    const inner = createTestLoggerService()
    const logger = createTauriLogger(inner)
    const cause = new Error('boom')

    logger.error('failed:', cause)
    logger.warn('careful')
    logger.info('done', { count: 1 })

    expect(inner.getErrors()).toEqual([{ message: 'failed:', cause }])
    expect(inner.getWarnings()).toEqual([{ message: 'careful', cause: undefined }])
    expect(inner.getInfos()).toEqual([{ message: 'done', cause: { count: 1 } }])
  })

  it('forwards each level with the cause rendered into the message', () => {
    const logger = createTauriLogger(createTestLoggerService())

    logger.error('failed:', new TypeError('boom'))
    logger.warn('careful')
    logger.info('done', { count: 1, ok: true })

    expect(pluginError).toHaveBeenCalledExactlyOnceWith('failed: TypeError: boom')
    expect(pluginWarn).toHaveBeenCalledExactlyOnceWith('careful')
    expect(pluginInfo).toHaveBeenCalledExactlyOnceWith('done {"count":1,"ok":true}')
  })

  it('renders a cause JSON cannot encode with `String`', () => {
    const logger = createTauriLogger(createTestLoggerService())
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    logger.info('cyclic', cyclic)
    logger.info('number', 42)

    expect(pluginInfo.mock.calls).toEqual([['cyclic [object Object]'], ['number 42']])
  })

  it('cuts a long cause', () => {
    const logger = createTauriLogger(createTestLoggerService())

    logger.info('long', 'x'.repeat(3000))

    expect(pluginInfo).toHaveBeenCalledExactlyOnceWith(`long ${'x'.repeat(2000)}…`)
  })

  it('swallows a failed forward without logging again', async () => {
    const inner = createTestLoggerService()
    const logger = createTauriLogger(inner)
    const rejected = Promise.reject(new Error('no plugin'))
    pluginError.mockReturnValueOnce(rejected)

    logger.error('failed')
    await rejected.catch(() => {})

    expect(inner.getErrors()).toEqual([{ message: 'failed', cause: undefined }])
    expect(pluginError).toHaveBeenCalledOnce()
  })
})
