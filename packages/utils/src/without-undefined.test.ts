import { describe, expect, it } from 'vitest'
import { withoutUndefined } from './without-undefined.ts'

describe('withoutUndefined', () => {
  it('drops undefined properties and keeps every other value', () => {
    const result = withoutUndefined<{ a: number; b?: string; c?: null; d?: boolean }>({
      a: 1,
      b: undefined,
      c: null,
      d: false,
    })

    expect(result).toEqual({ a: 1, c: null, d: false })
    expect('b' in result).toBe(false)
  })

  it('rejects undefined for a required property', () => {
    // @ts-expect-error `a` is required
    expect(withoutUndefined<{ a: number }>({ a: undefined })).toEqual({})
  })

  it('does not mutate its input', () => {
    const input = { a: undefined, b: 2 }

    withoutUndefined<{ a?: number; b: number }>(input)

    expect(input).toStrictEqual({ a: undefined, b: 2 })
  })
})
