import { describe, expect, it } from 'vitest'
import { changedFileSchema } from './commands'

describe('changedFileSchema', () => {
  it.each(['upsert', 'remove'])(
    'keeps %s notifications when native metadata is unavailable',
    (kind) => {
      for (const modifiedMs of [null, undefined]) {
        expect(changedFileSchema.parse({ path: 'notes/a.md', kind, modifiedMs })).toEqual({
          path: 'notes/a.md',
          kind,
          modifiedMs: undefined,
        })
      }
    },
  )

  it('preserves real timestamps and rejects malformed metadata', () => {
    expect(
      changedFileSchema.parse({
        path: 'notes/a.md',
        kind: 'upsert',
        modifiedMs: 1234,
      }).modifiedMs,
    ).toBe(1234)
    expect(
      changedFileSchema.safeParse({
        path: 'notes/a.md',
        kind: 'upsert',
        modifiedMs: '1234',
      }).success,
    ).toBe(false)
  })
})
