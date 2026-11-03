import { describe, expect, it } from 'vitest'
import { prepareBlockContext } from './block-context.ts'
import { findNoteMentions } from './note-mentions.ts'

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
    // A name ending in punctuation still ends a word: not inside `C++17`.
    expect(mentionTexts('C++17 replaced C++.\n', ['C++'])).toEqual(['C++'])
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

  it('judges word boundaries by the text a reader sees, past emphasis marks and escapes', () => {
    // "Acmes", "snake_Acme" and "Acme_v2" as rendered: longer words, not mentions.
    expect(mentionTexts('Acme*s* and **Acme**s, then **Acme**.\n', ['Acme'])).toEqual(['Acme'])
    expect(mentionTexts('snake\\_Acme, Acme\\_v2, Acme\\*.\n', ['Acme'])).toEqual(['Acme'])
  })

  it('matches a name whether its accents are stored composed or decomposed', () => {
    const composed = 'Caf\u{E9}'
    const decomposed = 'Cafe\u{301}'
    expect(mentionTexts(`Met at ${decomposed}, then ${composed}.\n`, [composed])).toEqual([
      decomposed,
      composed,
    ])
    expect(mentionTexts(`Met at ${composed}.\n`, [decomposed])).toEqual([composed])
  })

  it('never splits a character, even where no word boundary is needed', () => {
    // A Thai vowel sign, a decomposed kana's voiced mark, a decomposed Hangul
    // final consonant and a skin tone each belong to the character before them.
    expect(mentionTexts('ซื้อสมุดใหม่ แล้วเจอสม\n', ['สม'])).toEqual(['สม'])
    expect(mentionTexts(`${'トガ'.normalize('NFD')}とトカ\n`, ['トカ'])).toEqual(['トカ'])
    expect(mentionTexts(`${'가난'.normalize('NFD')} 가나\n`, ['가나'])).toEqual(['가나'])
    expect(
      mentionTexts('Ship it \u{1F44D}\u{1F3FD}, ship it \u{1F44D}.\n', ['ship it \u{1F44D}']),
    ).toEqual(['ship it \u{1F44D}'])
  })

  it('never starts a mention inside a character, however far back it began', () => {
    // Flag letters pair from the start of their run: in twenty US flags, an
    // "SU" pair always straddles two flags, however long the run.
    const flags = '\u{1F1FA}\u{1F1F8}'.repeat(20)
    expect(mentionTexts(`${flags}\n`, ['\u{1F1F8}\u{1F1FA}'])).toEqual([])
    expect(mentionTexts(`${flags}\n`, ['\u{1F1FA}\u{1F1F8}'])).toHaveLength(20)
  })

  it('finds a name beside an emoji or an astral character', () => {
    expect(mentionTexts('Shipped Acme\u{1F389} today.\n', ['Acme'])).toEqual(['Acme'])
    expect(mentionTexts('Kickoff for \u{1F680} Launch.\n', ['\u{1F680} Launch'])).toEqual([
      '\u{1F680} Launch',
    ])
    expect(mentionTexts('昨日は\u{20BB7}野家に行った。\n', ['\u{20BB7}野家'])).toEqual([
      '\u{20BB7}野家',
    ])
  })

  it('judges a boundary by the plain text the excerpt shows', () => {
    // Each reads as "BobAlice": not a whole-word mention.
    expect(mentionTexts('[Bob](u.)Alice, `Bob`Alice, [[Bob]]Alice.\n', ['Alice'])).toEqual([])
    // An image's URL is dropped, while HTML, a footnote and a line break stay
    // visible text, so each of these is a whole word.
    expect(
      mentionTexts('![](a.png)Alice, <b>Bob</b>Alice, Alice[^1], Alice<br>Bob.\n\n[^1]: x\n', [
        'Alice',
      ]),
    ).toEqual(['Alice', 'Alice', 'Alice', 'Alice'])
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
