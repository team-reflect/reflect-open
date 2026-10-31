import { describe, expect, it } from 'vitest'
import { safeParseUrl } from './index.ts'

describe('safeParseUrl', () => {
  it('parses an absolute URL', () => {
    expect(safeParseUrl('https://gitlab.com:8443/a/b.git')?.origin).toBe('https://gitlab.com:8443')
    expect(safeParseUrl('reflect://note/notes/foo.md')?.protocol).toBe('reflect:')
  })

  it('is null for anything that is not an absolute URL', () => {
    expect(safeParseUrl('')).toBeNull()
    expect(safeParseUrl('notes/foo.md')).toBeNull()
    expect(safeParseUrl('https://')).toBeNull()
  })
})
