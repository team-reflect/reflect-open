import { describe, expect, it } from 'vitest'
import { captureWireMessageSchema } from '@reflect/core/capture-envelope'
import { buildWireMessage, dataUrlToBase64, isCapturableUrl } from './capture-message'

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const CAPTURED_AT = new Date('2026-06-12T15:30:22.845Z')

describe('isCapturableUrl', () => {
  it('accepts only http(s) pages', () => {
    expect(isCapturableUrl('https://example.com')).toBe(true)
    expect(isCapturableUrl('http://localhost:3000')).toBe(true)
    expect(isCapturableUrl('chrome://extensions')).toBe(false)
    expect(isCapturableUrl('about:blank')).toBe(false)
    expect(isCapturableUrl(undefined)).toBe(false)
  })
})

describe('dataUrlToBase64', () => {
  it('strips the data-URL prefix', () => {
    expect(dataUrlToBase64('data:image/jpeg;base64,aGVsbG8=')).toBe('aGVsbG8=')
  })
})

describe('buildWireMessage', () => {
  it('builds a wire message the shared schema accepts', () => {
    const message = buildWireMessage({
      id: ID,
      capturedAt: CAPTURED_AT,
      url: 'https://example.com/article',
      title: '  An article  ',
      selection: 'quoted',
      note: 'check later',
      screenshotDataUrl: 'data:image/jpeg;base64,aGVsbG8=',
    })
    expect(captureWireMessageSchema.parse(message)).toEqual(message)
    expect(message.envelope.title).toBe('An article')
    expect(message.envelope.capturedAt).toBe('2026-06-12T15:30:22.845Z')
    expect(message.screenshotBase64).toBe('aGVsbG8=')
  })

  it('omits blank optionals instead of sending empty strings', () => {
    const message = buildWireMessage({
      id: ID,
      capturedAt: CAPTURED_AT,
      url: 'https://example.com',
      title: 'Example',
      selection: '   ',
      note: '',
    })
    expect(message.envelope.selection).toBeUndefined()
    expect(message.envelope.note).toBeUndefined()
    expect(message.screenshotBase64).toBeUndefined()
  })
})
