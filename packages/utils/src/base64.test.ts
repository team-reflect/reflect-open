import { describe, expect, it } from 'vitest'
import { base64ByteLength, base64ToBytes, base64ToUtf8, bytesToBase64 } from './index.ts'

describe('bytesToBase64', () => {
  it('matches btoa on small payloads', () => {
    expect(bytesToBase64(new TextEncoder().encode('abc'))).toBe(btoa('abc'))
  })

  it('survives payloads beyond one chunk', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).fill(65)
    expect(bytesToBase64(bytes)).toBe(btoa('A'.repeat(bytes.length)))
  })
})

describe('base64ToBytes', () => {
  it('is the exact inverse of bytesToBase64', () => {
    const bytes = new Uint8Array(1000).map((_zero, index) => index % 256)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })
})

describe('base64ByteLength', () => {
  it.each([
    ['', 0],
    ['YQ==', 1],
    ['YWI=', 2],
    ['YWJj', 3],
    ['YWJjZA==', 4],
    ['aGVsbG8=', 5],
  ])('measures %j without decoding', (base64, expected) => {
    expect(base64ByteLength(base64)).toBe(expected)
  })
})

describe('base64ToUtf8', () => {
  it('decodes Unicode text and empty input', () => {
    const text = '你好 café 🐈'
    expect(base64ToUtf8(bytesToBase64(new TextEncoder().encode(text)))).toBe(text)
    expect(base64ToUtf8('')).toBe('')
  })

  it('replaces invalid UTF-8 sequences', () => {
    expect(base64ToUtf8('/w==')).toBe('\u{FFFD}')
  })

  it('rejects invalid Base64', () => {
    expect(() => base64ToUtf8('!')).toThrow()
    expect(() => base64ToBytes('!')).toThrow()
  })
})
