import { describe, expect, it } from 'vitest'
import { extractEmailFields, foldEmail } from './email-fields'

describe('foldEmail', () => {
  it('trims and lowercases', () => {
    expect(foldEmail('  Ada@Example.COM ')).toBe('ada@example.com')
  })
})

describe('extractEmailFields', () => {
  it('extracts addresses from Email field bullets, keeping document order and casing', () => {
    const body = [
      '# Ada Lovelace',
      '',
      '- Type: #person',
      '- Email: Ada@Example.com',
      '- Email: ada.lovelace@work.example',
      '- Phone: +1 555-0100',
    ].join('\n')
    expect(extractEmailFields(body)).toEqual(['Ada@Example.com', 'ada.lovelace@work.example'])
  })

  it('accepts any list marker and any field casing', () => {
    expect(extractEmailFields('* EMAIL: ada@example.com')).toEqual(['ada@example.com'])
    expect(extractEmailFields('+ email: ada@example.com')).toEqual(['ada@example.com'])
    expect(extractEmailFields('  - Email: ada@example.com')).toEqual(['ada@example.com'])
  })

  it('reads several addresses from one bullet and dedups case-insensitively', () => {
    expect(extractEmailFields('- Email: a@x.com, B@Y.com\n- Email: b@y.com')).toEqual([
      'a@x.com',
      'B@Y.com',
    ])
  })

  it('unwraps a mailto link, collapsing the text/href pair', () => {
    expect(extractEmailFields('- Email: [ada@example.com](mailto:ada@example.com)')).toEqual([
      'ada@example.com',
    ])
  })

  it('strips sentence-final punctuation glued to an address', () => {
    expect(extractEmailFields('- Email: reach her at ada@example.com.')).toEqual([
      'ada@example.com',
    ])
  })

  it('ignores addresses outside Email field bullets — prose is a mention, not ownership', () => {
    const body = [
      '# Meeting notes',
      '',
      'Thread from ada@example.com about the launch.',
      '- Ask ada@example.com about timing',
      '- Phone: +1 555-0100',
    ].join('\n')
    expect(extractEmailFields(body)).toEqual([])
  })

  it('yields nothing for a bullet with no parseable address', () => {
    expect(extractEmailFields('- Email:\n- Email: ask reception')).toEqual([])
  })
})
