import { describe, expect, it } from 'vitest'
import {
  canonicalEmail,
  canonicalEmails,
  extractEmailFields,
  foldEmail,
} from './email-fields'

describe('foldEmail', () => {
  it('trims and lowercases', () => {
    expect(foldEmail('  Ada@Example.COM ')).toBe('ada@example.com')
  })

  it('treats envelopes, display names, and mailto values as one identity', () => {
    expect(canonicalEmail('<Ada@Example.COM>')).toBe('ada@example.com')
    expect(canonicalEmail('Ada Lovelace <Ada@Example.COM>')).toBe('ada@example.com')
    expect(canonicalEmail('<mailto:Ada@Example.COM>')).toBe('ada@example.com')
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
      canonicalEmails([
        ' Ada@Example.com ',
        '<ada@example.com>',
        '',
        'ada@work.example',
      ]),
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

    expect(extractEmailFields(body)).toEqual([
      'Ada@Example.com',
      'ada@work.example',
    ])
  })

  it('reads pre-2023 V1 Emails fields and nested mailto links', () => {
    const body = [
      '- Emails',
      '  - [Ada@Example.com](mailto:ada@example.com)',
      '  - <ada@work.example>',
    ].join('\n')

    expect(extractEmailFields(body)).toEqual([
      'Ada@Example.com',
      'ada@work.example',
    ])
  })

  it('handles an indented legacy field and tab-indented child', () => {
    expect(extractEmailFields('  * EMAIL:\n\t+ <ada@example.com>')).toEqual([
      'ada@example.com',
    ])
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
    const body = [
      '- Email: owner@example.com',
      '  - unrelated@example.com',
    ].join('\n')

    expect(extractEmailFields(body)).toEqual(['owner@example.com'])
  })

  it('ignores indented prose under a legacy Email field', () => {
    expect(
      extractEmailFields('- Email:\n  Reach Ada at unrelated@example.com'),
    ).toEqual([])
  })

  it('deduplicates bare and angle-wrapped field values', () => {
    expect(
      extractEmailFields('- Email: <Ada@Example.com>\n- Email: ada@example.com'),
    ).toEqual(['Ada@Example.com'])
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
