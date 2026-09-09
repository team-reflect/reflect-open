import { expect, it } from 'vitest'
import fixtures from './bookmark-envelope.fixtures.json'
import { bookmarkWireSchema } from './bookmark-envelope'
it('matches the native bookmark boundary fixtures', () => {
  for (const value of fixtures.accepted)
    expect(bookmarkWireSchema.safeParse(value).success).toBe(true)
  for (const value of fixtures.rejected)
    expect(bookmarkWireSchema.safeParse(value).success).toBe(false)
})
