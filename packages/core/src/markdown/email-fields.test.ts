import { describe, expect, it } from 'vitest'
import { canonicalEmail, canonicalEmails, extractEmailFields } from './email-fields.ts'

describe('canonicalEmail', () => {
  it('trims and lowercases', () => {
    expect(canonicalEmail('  Ada@Example.COM ')).toBe('ada@example.com')
  })

  it('treats envelopes, display names, and mailto values as one identity', () => {
    expect(canonicalEmail('<Ada@Example.COM>')).toBe('ada@example.com')
    expect(canonicalEmail('Ada Lovelace <Ada@Example.COM>')).toBe('ada@example.com')
    expect(canonicalEmail('<mailto:Ada@Example.COM>')).toBe('ada@example.com')
    expect(canonicalEmail('Ada < mailto:Ada@Example.com>')).toBe('ada@example.com')
  })

  it('drops the query and fragment of a mailto value', () => {
    expect(canonicalEmail('<mailto:Ada@Example.com?subject=Hi>')).toBe('ada@example.com')
    expect(canonicalEmail('mailto:ada@example.com#top')).toBe('ada@example.com')
  })

  it('handles long whitespace runs', () => {
    const spaces = ' '.repeat(50_000)
    expect(canonicalEmail(`<${spaces}x`)).toBe(`<${spaces}x`)
    expect(canonicalEmail(`<${spaces}ada@example.com>`)).toBe('ada@example.com')
  })

  it('preserves provider-significant dots and plus tags', () => {
    expect(canonicalEmail('<ada.lovelace+notes@example.com>')).toBe(
      'ada.lovelace+notes@example.com',
    )
  })
})

describe('canonicalEmails', () => {
  it('canonicalizes, removes blanks, and deduplicates in order', () => {
    expect(
      canonicalEmails([' Ada@Example.com ', '<ada@example.com>', '', 'ada@work.example']),
    ).toEqual(['ada@example.com', 'ada@work.example'])
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

  it('reads V1 addresses nested under an empty Email field', () => {
    const body = [
      '- Type: #person',
      '- Email:',
      '  - <Ada@Example.com>',
      '  - <ada@work.example>',
      '- Phone:',
      '  - [555-1234](tel:555-1234)',
    ].join('\n')

    expect(extractEmailFields(body)).toEqual(['Ada@Example.com', 'ada@work.example'])
  })

  it('reads pre-2023 V1 Emails fields and nested mailto links', () => {
    const body = [
      '- Emails',
      '  - [Ada@Example.com](mailto:ada@example.com)',
      '  - <ada@work.example>',
    ].join('\n')

    expect(extractEmailFields(body)).toEqual(['Ada@Example.com', 'ada@work.example'])
  })

  it('handles an indented legacy field and tab-indented child', () => {
    expect(extractEmailFields('  * EMAIL:\n\t+ <ada@example.com>')).toEqual(['ada@example.com'])
  })

  it('ends a legacy field at a sibling and ignores unrelated nested addresses', () => {
    const body = [
      '- Email:',
      '  - owner@example.com',
      '- Notes:',
      '  - unrelated@example.com',
    ].join('\n')

    expect(extractEmailFields(body)).toEqual(['owner@example.com'])
  })

  it('does not extend a populated inline field into nested list items', () => {
    const body = ['- Email: owner@example.com', '  - unrelated@example.com'].join('\n')

    expect(extractEmailFields(body)).toEqual(['owner@example.com'])
  })

  it('ignores indented prose under a legacy Email field', () => {
    expect(extractEmailFields('- Email:\n  Reach Ada at unrelated@example.com')).toEqual([])
  })

  it('deduplicates bare and angle-wrapped field values', () => {
    expect(extractEmailFields('- Email: <Ada@Example.com>\n- Email: ada@example.com')).toEqual([
      'Ada@Example.com',
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

  it('reads fields from CRLF line endings', () => {
    expect(extractEmailFields('- Email: ada@example.com\r\n- Email: bob@example.com\r\n')).toEqual([
      'ada@example.com',
      'bob@example.com',
    ])
    expect(extractEmailFields('- Email:\r\n  - ada@example.com\r\n- Phone: 1')).toEqual([
      'ada@example.com',
    ])
  })

  it('excludes Markdown marks and quotes around an address', () => {
    const body = [
      '- Email: **ada@example.com**',
      '- Email: `bob@example.com`',
      '- Email: _cy@example.com_',
      `- Email: "dee@example.com", 'eve@example.com'`,
    ].join('\n')

    expect(extractEmailFields(body)).toEqual([
      'ada@example.com',
      'bob@example.com',
      'cy@example.com',
      'dee@example.com',
      'eve@example.com',
    ])
  })

  it('splits addresses at CJK punctuation', () => {
    expect(extractEmailFields('- Email: ada@example.com，bob@example.com。')).toEqual([
      'ada@example.com',
      'bob@example.com',
    ])
  })

  it('ends an address at a query, a path, or trailing punctuation', () => {
    const body = [
      '- Email: [Ada](mailto:ada@example.com?subject=Hi)',
      '- Email: bob@example.com/inbox',
      '- Email: cy@example.com! dee@example.com-',
    ].join('\n')

    expect(extractEmailFields(body)).toEqual([
      'ada@example.com',
      'bob@example.com',
      'cy@example.com',
      'dee@example.com',
    ])
  })

  it('accepts internationalized and punycode domains', () => {
    expect(extractEmailFields('- Email: ada@例子.测试, bob@example.xn--p1ai')).toEqual([
      'ada@例子.测试',
      'bob@example.xn--p1ai',
    ])
  })

  it('handles long tokens without an address', () => {
    const run = 'a'.repeat(100_000)
    expect(extractEmailFields(`- Email: ${run}`)).toEqual([])
    expect(extractEmailFields(`- Email: ${run}@${run}`)).toEqual([])
  })

  it('handles long whitespace runs', () => {
    const spaces = ' '.repeat(50_000)
    expect(extractEmailFields(`- Email${spaces}x`)).toEqual([])
    expect(extractEmailFields(`- Email:${spaces}ada@example.com`)).toEqual(['ada@example.com'])
    expect(extractEmailFields(`- Email:\n  -${spaces}ada@example.com`)).toEqual(['ada@example.com'])
  })

  it('yields nothing for a bullet with no parseable address', () => {
    expect(extractEmailFields('- Email:\n- Email: ask reception')).toEqual([])
  })
})
