import { describe, expect, it } from 'vitest'
import { checkRoundTrip } from '@meowdown/markdown'

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
      'Title\n=====\n\nbody\n',
    ]
    for (const markdown of cases) {
      expect(checkRoundTrip(markdown), markdown).toBe('exact')
    }
  })

  it('classifies tightened loose lists as normalizing (content preserved)', () => {
    expect(checkRoundTrip('- item one\n\n- item two\n')).toBe('normalizing')
  })

  it('classifies git conflict markers as normalizing', () => {
    // `>>>>>>> x` re-serializes as `> > > > > > > x`, the same nested blockquotes.
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
    expect(checkRoundTrip(conflicted)).toBe('normalizing')
  })
})
