import { describe, expect, it } from 'vitest'
import { hashContent } from './hash'

describe('hashContent', () => {
  it('is deterministic, content-sensitive, and hex-encoded', async () => {
    const helloHash = await hashContent('hello')
    expect(helloHash).toBe(await hashContent('hello'))
    expect(helloHash).not.toBe(await hashContent('hello!'))
    expect(helloHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
