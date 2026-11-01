import { describe, expect, it } from 'vitest'
import { prepareBlockContext } from './block-context.ts'
import { findNoteMentions, linksToAnyName } from './note-mentions.ts'

function mentionTexts(content: string, names: readonly string[]): string[] {
  return findNoteMentions(prepareBlockContext(content), names).map((mention) => mention.text)
}

describe('findNoteMentions', () => {
  it('finds case-insensitive whole-word mentions with whole-file offsets', () => {
    const content = '---\ntags: [x]\n---\n\nLunch with sarah, then Sarah again.\n'
    const mentions = findNoteMentions(prepareBlockContext(content), ['Sarah'])
    expect(mentions.map((mention) => mention.text)).toEqual(['sarah', 'Sarah'])
    for (const mention of mentions) {
      expect(content.slice(mention.from, mention.to)).toBe(mention.text)
    }
  })

  it('ignores a name inside a longer word', () => {
    expect(mentionTexts('Annual review, Annie, and Ann.\n', ['Ann'])).toEqual(['Ann'])
  })

  it('skips links, code, URLs, hashtags, and the title heading', () => {
    const content = [
      '# Sarah notes',
      '',
      'See [[Sarah]] and [Sarah](https://example.com/sarah) and `Sarah` and #sarah.',
      'Also https://sarah.example.com and ![[Sarah]] and <span title="Sarah">x</span>.',
      '',
      '```',
      'Sarah',
      '```',
      '',
      'Only this Sarah counts.',
    ].join('\n')
    expect(mentionTexts(content, ['Sarah'])).toEqual(['Sarah'])
  })

  it('treats every H1 as prose when frontmatter owns the title', () => {
    const content = '---\ntitle: Weekly\n---\n\n# Sarah\n'
    expect(mentionTexts(content, ['Sarah'])).toEqual(['Sarah'])
  })

  it('prefers the longest name at one position', () => {
    expect(mentionTexts('Met Ann Lee and Ann.\n', ['Ann', 'Ann Lee'])).toEqual(['Ann Lee', 'Ann'])
  })

  it('escapes names that contain pattern characters', () => {
    expect(mentionTexts('Learning C++ and C# today.\n', ['C++'])).toEqual(['C++'])
  })

  it('matches unsegmented scripts without word boundaries', () => {
    expect(mentionTexts('今日は田中さんと会った。\n', ['田中'])).toEqual(['田中'])
  })

  it('keeps a shorter mention that a rejected longer one overlaps', () => {
    expect(mentionTexts('Tagged #Ann Lee today.\n', ['Ann Lee', 'Lee'])).toEqual(['Lee'])
    expect(mentionTexts('Met Ann Leeds.\n', ['Ann Lee', 'Ann'])).toEqual(['Ann'])
  })

  it('skips a mention right after `!`, where a link would become an embed', () => {
    expect(mentionTexts('Thanks!Ann Lee, and Ann Lee.\n', ['Ann Lee'])).toEqual(['Ann Lee'])
    const mentions = findNoteMentions(prepareBlockContext('Thanks!Ann Lee, and Ann Lee.\n'), [
      'Ann Lee',
    ])
    expect(mentions.map((mention) => mention.from)).toEqual([20])
  })

  it('skips a mention inside plain brackets, where a link would triple them', () => {
    expect(mentionTexts('See [Acme Corp] and Acme Corp.\n', ['Acme Corp'])).toEqual(['Acme Corp'])
    expect(
      findNoteMentions(prepareBlockContext('See [Acme Corp] and Acme Corp.\n'), ['Acme Corp']).map(
        (mention) => mention.from,
      ),
    ).toEqual([20])
  })

  it('retries past a rejected name that starts with an astral character', () => {
    // `[[🎉 Launch]]` is a link, so its match is rejected; the retry must step
    // over the whole emoji rather than land inside its surrogate pair.
    const content = 'See [[🎉 Launch]] and 🎉 Launch.\n'
    expect(mentionTexts(content, ['🎉 Launch'])).toEqual(['🎉 Launch'])
  })

  it('skips text that matches only by a fold links do not make', () => {
    expect(mentionTexts('Read Gau\u{17F}s and Gauss.\n', ['Gauss'])).toEqual(['Gauss'])
  })

  it('treats a following combining mark as part of the word (Indic vowel signs)', () => {
    expect(mentionTexts('रामायण पढ़ा, फिर राम आया।\n', ['राम'])).toEqual(['राम'])
    expect(mentionTexts('सीताराम और सीता\n', ['सीता'])).toEqual(['सीता'])
  })

  it('accepts a mention inside underscore emphasis, but not after a literal underscore', () => {
    expect(mentionTexts('Met _Alice Smith_ and __Alice Smith__.\n', ['Alice Smith'])).toEqual([
      'Alice Smith',
      'Alice Smith',
    ])
    expect(mentionTexts('see snake_Alice Smith\n', ['Alice Smith'])).toEqual([])
  })

  it('skips a name glued to a backslash: a path segment, not a mention', () => {
    expect(mentionTexts('Files in C:\\Users\\Alice\\docs, ask Alice.\n', ['Alice'])).toEqual([
      'Alice',
    ])
  })

  it('returns nothing when there are no names', () => {
    expect(mentionTexts('Sarah\n', [])).toEqual([])
  })
})

describe('linksToAnyName', () => {
  it('sees a wiki link or embed to any of the names, in any case or with a display', () => {
    const linked = (content: string): boolean => {
      return linksToAnyName(prepareBlockContext(content), ['Acme Corp', 'Acme'])
    }
    expect(linked('Met [[acme corp|them]].\n')).toBe(true)
    expect(linked('![[Acme]]\n')).toBe(true)
    expect(linked('Met [[Acme Inc]] and Acme.\n')).toBe(false)
    expect(linked('`[[Acme]]` in code\n')).toBe(false)
  })

  it('reads an escaped link target the way the indexer does', () => {
    expect(linksToAnyName(prepareBlockContext('See [[Notes\\_2024]].\n'), ['Notes_2024'])).toBe(
      true,
    )
  })
})
