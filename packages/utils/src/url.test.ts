import { describe, expect, it } from 'vitest'
import { parseUrl } from './index.ts'

describe('parseUrl', () => {
  it('parses an absolute URL', () => {
    expect(parseUrl('https://gitlab.com:8443/a/b.git')?.origin).toBe('https://gitlab.com:8443')
    expect(parseUrl('reflect://note/notes/foo.md')?.protocol).toBe('reflect:')
  })

  it('is null for anything that is not an absolute URL', () => {
    expect(parseUrl('')).toBeNull()
    expect(parseUrl('notes/foo.md')).toBeNull()
    expect(parseUrl('https://')).toBeNull()
  })
})
