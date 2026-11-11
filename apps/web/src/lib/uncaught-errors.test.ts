import { describe, expect, it } from 'vitest'
import { createTestLoggerService } from '@reflect/core/testing'
import { installUncaughtErrorLogging } from './uncaught-errors.ts'

function dispatch(target: EventTarget, type: string, fields: Record<string, unknown>): void {
  target.dispatchEvent(Object.assign(new Event(type), fields))
}

function withStack(error: Error, stack: string): Error {
  return Object.assign(error, { stack })
}

describe('installUncaughtErrorLogging', () => {
  it('logs the name, message and stack of an uncaught error', () => {
    const target = new EventTarget()
    const logger = createTestLoggerService()
    installUncaughtErrorLogging(target, logger)

    const error = withStack(new TypeError('boom'), 'TypeError: boom\n    at mount (editor.js:1:2)')
    dispatch(target, 'error', { error, message: 'Uncaught TypeError: boom' })

    expect(logger.getErrors()).toEqual([
      {
        message: 'uncaught error: TypeError: boom\n    at mount (editor.js:1:2)',
        cause: undefined,
      },
    ])
  })

  it('adds the header when the stack holds only frames', () => {
    const target = new EventTarget()
    const logger = createTestLoggerService()
    installUncaughtErrorLogging(target, logger)

    const error = withStack(new RangeError('too deep'), 'mount@editor.js:1:2')
    dispatch(target, 'error', { error })

    expect(logger.getErrors()).toEqual([
      { message: 'uncaught error: RangeError: too deep\nmount@editor.js:1:2', cause: undefined },
    ])
  })

  it('falls back to the event message when the error is not an Error', () => {
    const target = new EventTarget()
    const logger = createTestLoggerService()
    installUncaughtErrorLogging(target, logger)

    dispatch(target, 'error', { error: 'oops', message: 'Uncaught oops' })

    expect(logger.getErrors()).toEqual([
      { message: 'uncaught error: Uncaught oops', cause: undefined },
    ])
  })

  it('logs the reason of an unhandled rejection', () => {
    const target = new EventTarget()
    const logger = createTestLoggerService()
    installUncaughtErrorLogging(target, logger)

    const error = withStack(new Error('denied'), 'Error: denied\n    at save (store.js:3:4)')
    dispatch(target, 'unhandledrejection', { reason: error })
    dispatch(target, 'unhandledrejection', { reason: 'timeout' })

    expect(logger.getErrors()).toEqual([
      {
        message: 'unhandled rejection: Error: denied\n    at save (store.js:3:4)',
        cause: undefined,
      },
      { message: 'unhandled rejection: timeout', cause: undefined },
    ])
  })
})
