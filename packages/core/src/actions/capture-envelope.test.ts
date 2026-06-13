import { describe, expect, it } from 'vitest'
import {
  captureAckSchema,
  captureEnvelopeSchema,
  captureWireMessageSchema,
} from './capture-envelope'

const VALID = {
  version: 1,
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  url: 'https://example.com/article',
  title: 'An article',
  capturedAt: '2026-06-12T15:30:22.845Z',
  source: 'extension',
}

describe('captureEnvelopeSchema', () => {
  it('accepts a minimal envelope', () => {
    expect(captureEnvelopeSchema.parse(VALID)).toEqual(VALID)
  })

  it('accepts the full shape with selection, note, and screenshot', () => {
    const full = {
      ...VALID,
      selection: 'quoted text',
      note: 'check this later',
      screenshotRef: `${VALID.id}.jpg`,
    }
    expect(captureEnvelopeSchema.parse(full)).toEqual(full)
  })

  it('accepts an offset timestamp', () => {
    const parsed = captureEnvelopeSchema.safeParse({
      ...VALID,
      capturedAt: '2026-06-12T15:30:22.845-07:00',
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    ['wrong version', { ...VALID, version: 2 }],
    ['non-uuid id', { ...VALID, id: 'not-a-uuid' }],
    ['non-url url', { ...VALID, url: 'example dot com' }],
    ['missing title', { ...VALID, title: undefined }],
    ['bad timestamp', { ...VALID, capturedAt: 'yesterday' }],
    ['unknown source', { ...VALID, source: 'carrier-pigeon' }],
  ])('rejects %s', (_label, candidate) => {
    expect(captureEnvelopeSchema.safeParse(candidate).success).toBe(false)
  })
})

describe('captureWireMessageSchema', () => {
  it('accepts an envelope without screenshotRef plus screenshot bytes', () => {
    const parsed = captureWireMessageSchema.safeParse({
      envelope: VALID,
      screenshotBase64: 'aGVsbG8=',
    })
    expect(parsed.success).toBe(true)
  })

  it('strips a pre-stamped screenshotRef (the host owns it)', () => {
    const parsed = captureWireMessageSchema.parse({
      envelope: { ...VALID, screenshotRef: 'sneaky.jpg' },
    })
    expect(parsed.envelope).not.toHaveProperty('screenshotRef')
  })
})

describe('captureAckSchema', () => {
  it('accepts the queued success', () => {
    expect(captureAckSchema.safeParse({ ok: true, status: 'queued' }).success).toBe(true)
  })

  it('never accepts a "saved" claim', () => {
    expect(captureAckSchema.safeParse({ ok: true, status: 'saved' }).success).toBe(false)
  })

  it('accepts typed failures', () => {
    const parsed = captureAckSchema.safeParse({
      ok: false,
      code: 'no-graph',
      message: 'open Reflect and pick a graph first',
    })
    expect(parsed.success).toBe(true)
  })
})
