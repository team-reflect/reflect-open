import { expect, it } from 'vitest'
import fixtures from './bookmark-envelope.fixtures.json' with { type: 'json' }
import { extensionCaptureWireSchema, inboxEnvelopeSchema } from './capture-envelope.ts'
import { xPostWireSchema } from './bookmark-envelope.ts'

it('validates X post envelopes for wire and inbox', () => {
  for (const value of fixtures.accepted) {
    expect(xPostWireSchema.safeParse(value).success).toBe(true)
    expect(extensionCaptureWireSchema.safeParse(value).success).toBe(true)
  }
  for (const value of fixtures.spooled) expect(inboxEnvelopeSchema.parse(value)).toEqual(value)
  for (const value of fixtures.rejected)
    expect(xPostWireSchema.safeParse(value).success).toBe(false)
})
