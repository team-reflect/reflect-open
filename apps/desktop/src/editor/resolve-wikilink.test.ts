import { describe, expect, it } from 'vitest'
import { resolveWikilink } from './resolve-wikilink'

describe('resolveWikilink', () => {
  it('splits an alias at the first pipe, trimming both halves', () => {
    expect(resolveWikilink({ target: 'Tim MacCaw // Dad|Dad' })).toEqual({
      target: 'Tim MacCaw // Dad',
      display: 'Dad',
    })
    expect(resolveWikilink({ target: 'a | b | c' })).toEqual({ target: 'a', display: 'b | c' })
  })

  it('falls back to the display title for a blank alias', () => {
    expect(resolveWikilink({ target: 'Note|' })).toEqual({ target: 'Note', display: 'Note' })
    expect(resolveWikilink({ target: 'Tim MacCaw // Dad| ' })).toEqual({
      target: 'Tim MacCaw // Dad',
      display: 'Tim MacCaw',
    })
  })

  it('shows a bare `//` target by its first segment', () => {
    expect(resolveWikilink({ target: 'Tim MacCaw // Dad' })).toEqual({
      target: 'Tim MacCaw // Dad',
      display: 'Tim MacCaw',
    })
    expect(resolveWikilink({ target: '// Dad' })).toEqual({ target: '// Dad', display: 'Dad' })
  })

  it('leaves a plain target and a URL-shaped target alone', () => {
    expect(resolveWikilink({ target: 'Note' })).toBeUndefined()
    expect(resolveWikilink({ target: 'https://reflect.app' })).toBeUndefined()
  })
})
