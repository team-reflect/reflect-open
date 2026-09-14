import { expect, it } from 'vitest'
import fixtures from './like-envelope.fixtures.json'
import { extensionCaptureWireSchema, inboxEnvelopeSchema, likeWireSchema } from './capture-envelope'

it('matches native like boundary fixtures and both capture unions', () => {
  for (const value of fixtures.accepted) {
    expect(likeWireSchema.parse(value)).toEqual(value)
    expect(extensionCaptureWireSchema.parse(value)).toEqual(value)
  }
  for (const value of fixtures.spooled) expect(inboxEnvelopeSchema.parse(value)).toEqual(value)
  for (const value of fixtures.rejected) expect(likeWireSchema.safeParse(value).success).toBe(false)
})


it('accepts a captured snapshot as well as the URL-only fallback', () => {
  const metadata = fixtures.accepted[0]!.envelope
  const { postId: _postId, ...rest } = metadata
  const snapshot = { envelope: { ...rest, data: {
    id: '20', createdAt: '', author: { name: '', handle: '' }, body: [],
  } } }
  expect(likeWireSchema.parse(snapshot)).toEqual(snapshot)
  expect(inboxEnvelopeSchema.parse(snapshot.envelope)).toEqual(snapshot.envelope)
})
