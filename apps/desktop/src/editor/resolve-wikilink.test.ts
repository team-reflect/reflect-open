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

  it('keeps an empty alias as an empty label', () => {
    expect(resolveWikilink({ target: 'Note|' })).toEqual({ target: 'Note', display: '' })
  })

  it('shows a bare `//` target by its first segment', () => {
    expect(resolveWikilink({ target: 'Tim MacCaw // Dad' })).toEqual({ display: 'Tim MacCaw' })
    expect(resolveWikilink({ target: '// Dad' })).toEqual({ display: 'Dad' })
  })

  it('leaves a plain target and a URL-shaped target alone', () => {
    expect(resolveWikilink({ target: 'Note' })).toBeUndefined()
    expect(resolveWikilink({ target: 'https://reflect.app' })).toBeUndefined()
  })
})
