import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from './base64'

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
