import { describe, expect, it } from 'vitest'
import { zoteroItemLink, zoteroItemSchema, zoteroItemSummary } from './commands'

const baseItem = {
  key: 'ABCD1234',
  title: 'Attention is all you need',
  creators: ['Vaswani, Ashish'],
  date: '2017-06-12',
  itemType: 'journalArticle',
}

describe('zoteroItemLink', () => {
  it('builds the zotero:// deep link from key and title', () => {
    expect(zoteroItemLink(baseItem)).toBe(
      '[Attention is all you need](zotero://select/library/items/ABCD1234)',
    )
  })

  it('escapes brackets in the title so they cannot break the link text', () => {
    const item = { ...baseItem, title: 'Brackets [in] title' }
    expect(zoteroItemLink(item)).toBe(
      String.raw`[Brackets \[in\] title](zotero://select/library/items/ABCD1234)`,
    )
  })

  it('escapes backslashes before brackets', () => {
    const item = { ...baseItem, title: String.raw`Back\slash` }
    expect(zoteroItemLink(item)).toBe(
      String.raw`[Back\\slash](zotero://select/library/items/ABCD1234)`,
    )
  })

  it('falls back to a generic label for an empty title', () => {
    const item = { ...baseItem, title: '   ' }
    expect(zoteroItemLink(item)).toBe('[Zotero item](zotero://select/library/items/ABCD1234)')
  })
})

describe('zoteroItemSummary', () => {
  it('combines the first creator and the year', () => {
    expect(zoteroItemSummary(baseItem)).toBe('Vaswani, Ashish, 2017')
  })

  it('drops the year when the date is absent or month-only', () => {
    expect(zoteroItemSummary({ ...baseItem, date: null })).toBe('Vaswani, Ashish')
    expect(zoteroItemSummary({ ...baseItem, date: 'n.d.' })).toBe('Vaswani, Ashish')
  })

  it('drops the creator when the item has none', () => {
    expect(zoteroItemSummary({ ...baseItem, creators: [] })).toBe('2017')
  })

  it('is empty for an item with no creator and no date', () => {
    expect(zoteroItemSummary({ ...baseItem, creators: [], date: null })).toBe('')
  })
})

describe('zoteroItemSchema', () => {
  it('accepts the Rust command payload shape', () => {
    expect(zoteroItemSchema.parse(baseItem)).toEqual(baseItem)
    expect(zoteroItemSchema.parse({ ...baseItem, date: null })).toEqual({ ...baseItem, date: null })
  })

  it('rejects a payload missing the item key', () => {
    const { key: _key, ...rest } = baseItem
    expect(zoteroItemSchema.safeParse(rest).success).toBe(false)
  })
})
