import { describe, expect, it } from 'vitest'
import { errorMessage, isAppError, ReflectError, toAppError } from './errors'

describe('isAppError', () => {
  it('accepts every contract kind', () => {
    for (const kind of ['io', 'notFound', 'traversal', 'noGraph', 'parse', 'auth', 'network', 'unknown']) {
      expect(isAppError({ kind, message: 'm' })).toBe(true)
    }
  })

  it('rejects shapes outside the contract', () => {
    expect(isAppError({ kind: 'bogus', message: 'm' })).toBe(false)
    expect(isAppError({ kind: 'io' })).toBe(false) // missing message
    expect(isAppError({ message: 'm' })).toBe(false)
    expect(isAppError('io error')).toBe(false)
    expect(isAppError(null)).toBe(false)
    expect(isAppError(undefined)).toBe(false)
  })

  it('accepts thrown ReflectError instances (load-bearing for sync state mapping)', () => {
    // The engine's statusForError branches on isAppError to map a thrown
    // ReflectError('network') to the `offline` state (and 'auth' to the
    // reconnect affordance). zod's object parser reads the declared shape
    // keys by direct property access, so the Error subclass's own `kind`
    // field and `message` satisfy the union — pinned here because the whole
    // offline/auth UX rests on it.
    const error = new ReflectError('network', 'unreachable')
    expect(isAppError(error)).toBe(true)
    expect(toAppError(error)).toEqual({ kind: 'network', message: 'unreachable' })
    expect(isAppError(new ReflectError('auth', 'rejected'))).toBe(true)
  })
})

describe('toAppError', () => {
  it('passes a well-formed command error through unchanged', () => {
    const rustError = { kind: 'notFound', message: 'no such note' }
    expect(toAppError(rustError)).toEqual(rustError)
  })

  it('coerces an Error to unknown with its message', () => {
    expect(toAppError(new Error('boom'))).toEqual({ kind: 'unknown', message: 'boom' })
  })

  it('coerces a plain string', () => {
    expect(toAppError('plain failure')).toEqual({ kind: 'unknown', message: 'plain failure' })
  })

  it('serializes arbitrary objects as JSON', () => {
    expect(toAppError({ code: 7 })).toEqual({ kind: 'unknown', message: '{"code":7}' })
  })

  it('never throws on values JSON.stringify rejects', () => {
    expect(toAppError(BigInt(1)).kind).toBe('unknown')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(toAppError(circular).kind).toBe('unknown')
  })

  it('coerces null and undefined without throwing', () => {
    expect(toAppError(null)).toEqual({ kind: 'unknown', message: 'null' })
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
