import { sha256Hex } from '@reflect/utils'
import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256.ts'

describe('sha256HexSync', () => {
  it.each([
    '',
    'abc',
    '+ [ ] caf\u{E9} \u{1F600}\n',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(200),
  ])('equals sha256Hex for %j', async (text) => {
    expect(sha256HexSync(text)).toBe(await sha256Hex(text))
  })
})
