import { describe, expect, it } from 'vitest'
import { checkRoundTrip } from './roundtrip'

describe('checkRoundTrip', () => {
  it('classifies faithful content as exact', () => {
    const cases = [
      '# Heading\n\nA paragraph with [[Wiki Link]] and **bold**.\n',
      '> quote\n',
      '```\ncode [[not a link]]\n\nblank line inside fence\n```\n',
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
      '- item one\n- item two\n',
      '- [ ] buy milk\n- [x] done\n',
      '<div>raw html</div>\n',
    ]
    for (const markdown of cases) {
      expect(checkRoundTrip(markdown), markdown).toBe('exact')
    }
  })

  it('classifies tightened loose lists as normalizing (content preserved)', () => {
    expect(checkRoundTrip('- item one\n\n- item two\n')).toBe('normalizing')
  })

  it('classifies remaining converter gaps as lossy', () => {
    // Setext heading text is dropped (`Title\n=====` → empty heading). The guard
    // exists to catch exactly this; when a gap is fixed upstream, its case starts
    // failing and can move to exact (raw HTML blocks now round-trip exactly).
    expect(checkRoundTrip('Title\n=====\n\nbody\n')).toBe('lossy')
  })

  it('classifies git conflict markers as lossy (sync conflicts open protected)', () => {
    // Load-bearing for Plan 12: a sync merge commits raw conflict markers into
    // the note, and the converter mangles them (`<<<<<<<` is swallowed, the
    // `=======` separator re-parses as a setext underline, `>>>>>>>` becomes
    // nested blockquotes — verified by the discovery spike). `lossy` is what
    // routes conflicted notes into the protected read-only view, where the
    // conflict notice offers marker-aware resolution on the raw text instead
    // of ever letting the editor rewrite (and destroy) the markers. If
    // meowdown ever learns to round-trip markers, this case starts failing —
    // that is the signal the in-editor conflict widget can be built.
    const conflicted = [
      '# Shared',
      '',
      '<<<<<<< this device',
      'edited on a',
      '=======',
      'edited on b',
      '>>>>>>> other device',
      '',
    ].join('\n')
    expect(checkRoundTrip(conflicted)).toBe('lossy')
  })
})
