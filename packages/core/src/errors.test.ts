import { describe, expect, it } from 'vitest'
import { AppError, errorMessage, isAppError, toAppError } from './errors.ts'

describe('isAppError', () => {
  it('accepts AppError instances and their subclasses', () => {
    class OversizeError extends AppError {}
    expect(isAppError(new AppError('network', 'unreachable'))).toBe(true)
    expect(isAppError(new OversizeError('parse', 'too big'))).toBe(true)
  })

  it('rejects everything that is not an AppError instance', () => {
    expect(isAppError({ kind: 'io', message: 'm' })).toBe(false)
    expect(isAppError(new Error('m'))).toBe(false)
    expect(isAppError('io error')).toBe(false)
    expect(isAppError(null)).toBe(false)
    expect(isAppError(undefined)).toBe(false)
  })
})

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const error = new AppError('auth', 'rejected')
    expect(toAppError(error)).toBe(error)
  })

  it('keeps the kind of a serialized Rust error', () => {
    for (const kind of [
      'io',
      'notFound',
      'traversal',
      'noGraph',
      'parse',
      'auth',
      'network',
      'unknown',
    ] as const) {
      expect(toAppError({ kind, message: 'm' })).toEqual(new AppError(kind, 'm'))
    }
  })

  it('treats shapes outside the Rust contract as unknown', () => {
    expect(toAppError({ kind: 'bogus', message: 'm' }).kind).toBe('unknown')
    expect(toAppError({ kind: 'io' }).kind).toBe('unknown')
  })

  it('coerces an Error to unknown with its message and cause', () => {
    const cause = new Error('boom')
    const error = toAppError(cause)
    expect(error).toEqual(new AppError('unknown', 'boom'))
    expect(error.cause).toBe(cause)
  })

  it('coerces a plain string', () => {
    expect(toAppError('plain failure')).toEqual(new AppError('unknown', 'plain failure'))
  })

  it('serializes arbitrary objects as JSON', () => {
    expect(toAppError({ code: 7 })).toEqual(new AppError('unknown', '{"code":7}'))
  })

  it('never throws on values JSON.stringify rejects', () => {
    expect(toAppError(1n).kind).toBe('unknown')

    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(toAppError(circular).kind).toBe('unknown')
  })

  it('coerces null and undefined without throwing', () => {
    expect(toAppError(null)).toEqual(new AppError('unknown', 'null'))
    expect(toAppError(undefined).kind).toBe('unknown')
  })
})

describe('errorMessage', () => {
  it('uses the command error message when well-formed', () => {
    expect(errorMessage({ kind: 'io', message: 'disk full' })).toBe('disk full')
  })

  it('normalizes Errors, strings, and arbitrary objects', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain failure')).toBe('plain failure')
    expect(errorMessage({ code: 7 })).toBe('{"code":7}')
  })
})
