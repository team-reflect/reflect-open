import { describe, expect, it } from 'vitest'
import {
  captureAckSchema,
  captureEnvelopeSchema,
  captureWireMessageSchema,
  inboxEnvelopeSchema,
  textCaptureEnvelopeSchema,
  TEXT_CAPTURE_MAX_LENGTH,
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

  it('accepts the full shape with selection, page text, note, and screenshot', () => {
    const full = {
      ...VALID,
      selection: 'quoted text',
      contentText: 'First paragraph.\n\nSecond paragraph.',
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

const VALID_TEXT = {
  version: 1,
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  kind: 'append',
  text: 'call the bank',
  capturedAt: '2026-06-12T15:30:22.845Z',
  source: 'deep-link',
}

describe('textCaptureEnvelopeSchema', () => {
  it('accepts both capture kinds', () => {
    expect(textCaptureEnvelopeSchema.parse(VALID_TEXT)).toEqual(VALID_TEXT)
    expect(
      textCaptureEnvelopeSchema.safeParse({ ...VALID_TEXT, kind: 'task' }).success,
    ).toBe(true)
  })

  it.each([
    ['empty text', { ...VALID_TEXT, text: '' }],
    ['whitespace-only text', { ...VALID_TEXT, text: '  \t ' }],
    ['multi-line text', { ...VALID_TEXT, text: 'one\ntwo' }],
    ['over-cap text', { ...VALID_TEXT, text: 'a'.repeat(TEXT_CAPTURE_MAX_LENGTH + 1) }],
    ['unknown kind', { ...VALID_TEXT, kind: 'note' }],
    ['unknown source', { ...VALID_TEXT, source: 'carrier-pigeon' }],
    ['non-uuid id', { ...VALID_TEXT, id: 'nope' }],
  ])('rejects %s', (_label, candidate) => {
    expect(textCaptureEnvelopeSchema.safeParse(candidate).success).toBe(false)
  })
})

describe('inboxEnvelopeSchema', () => {
  it('dispatches on shape: `kind` makes a text envelope, its absence a link one', () => {
    expect(inboxEnvelopeSchema.parse(VALID)).toEqual(VALID)
    expect(inboxEnvelopeSchema.parse(VALID_TEXT)).toEqual(VALID_TEXT)
  })

  it('rejects a hybrid that satisfies neither shape fully', () => {
    expect(inboxEnvelopeSchema.safeParse({ ...VALID_TEXT, kind: undefined }).success).toBe(false)
  })
})
