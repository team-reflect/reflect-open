import { describe, expect, it, vi } from 'vitest'
import { createConsoleLogger } from './logger-service.ts'
import { noop } from '@ocavue/utils'

describe('createConsoleLogger', () => {
  it('forwards each level to the matching console method', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(noop)
    const warn = vi.spyOn(console, 'warn').mockImplementation(noop)
    const info = vi.spyOn(console, 'info').mockImplementation(noop)
    const logger = createConsoleLogger()
    const cause = new Error('boom')

    logger.error('failed:', cause)
    logger.warn('careful', 42)
    logger.info('done', { count: 1 })

    expect(error).toHaveBeenCalledExactlyOnceWith('failed:', cause)
    expect(warn).toHaveBeenCalledExactlyOnceWith('careful', 42)
    expect(info).toHaveBeenCalledExactlyOnceWith('done', { count: 1 })
  })

  it('passes a message without a cause as a single argument', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(noop)
    createConsoleLogger().error('only a message')

    expect(error.mock.calls).toEqual([['only a message']])
  })
})
