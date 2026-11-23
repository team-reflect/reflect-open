import { describe, expect, it } from 'vitest'
import { sha256Hex, sha256HexSync } from './sha256.ts'
describe('sha256Hex', () => {
  it('returns lowercase hex SHA-256', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    await expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('is deterministic, content-sensitive, and hex-encoded', async () => {
    const helloHash = await sha256Hex('hello')
    expect(helloHash).toBe(await sha256Hex('hello'))
    expect(helloHash).not.toBe(await sha256Hex('hello!'))
    expect(helloHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes UTF-8 bytes', async () => {
    await expect(sha256Hex('\u{E9}')).resolves.toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    )
  })

  it('gives the hash that `note_write` reports for the same note text', async () => {
    await expect(sha256Hex('a\nb\n')).resolves.toBe(
      '911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2',
    )
  })
})

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
