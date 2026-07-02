import { describe, expect, it } from 'vitest'
import type { ContactMatch } from './commands'
import { appendContactDetails, contactDetailsMarkdown, noteHasContactDetails } from './markdown'

function contact(overrides: Partial<ContactMatch>): ContactMatch {
  return {
    fullName: 'Ada Lovelace',
    givenName: 'Ada',
    familyName: 'Lovelace',
    emails: [],
    phones: [],
    ...overrides,
  }
}

describe('contactDetailsMarkdown', () => {
  it('writes the person typing line, then every email and phone', () => {
    const details = contactDetailsMarkdown(
      contact({
        emails: ['ada@example.com', 'ada@work.com'],
        phones: ['+1 555 0100', '+1 555 0199'],
      }),
    )
    expect(details).toBe(
      [
        '- Type: #person',
        '- Email: ada@example.com',
        '- Email: ada@work.com',
        '- Phone: +1 555 0100',
        '- Phone: +1 555 0199',
      ].join('\n'),
    )
  })

  it('dedupes values case-insensitively, keeping first casing and order', () => {
    const details = contactDetailsMarkdown(
      contact({ emails: ['Ada@Example.com', 'ada@example.com', 'ada@work.com'] }),
    )
    expect(details).toBe('- Type: #person\n- Email: Ada@Example.com\n- Email: ada@work.com')
  })

  it('omits the typing line when the target body already carries a Type bullet', () => {
    const details = contactDetailsMarkdown(
      contact({ emails: ['ada@example.com'] }),
      '- Type: #person\n',
    )
    expect(details).toBe('- Email: ada@example.com')
  })

  it('yields nothing for a contact with no email and no phone (no card to offer)', () => {
    expect(contactDetailsMarkdown(contact({}))).toBe('')
    expect(contactDetailsMarkdown(contact({ emails: ['  '] }))).toBe('')
  })
})

describe('appendContactDetails', () => {
  const ada = contact({ emails: ['ada@example.com'], phones: ['+1 555 0100'] })
  const adaBlock = '- Type: #person\n- Email: ada@example.com\n- Phone: +1 555 0100'

  it('appends after existing content with a blank-line block separation', () => {
    expect(appendContactDetails('# Ada Lovelace\n\nMet at the conference.\n', ada)).toBe(
      `# Ada Lovelace\n\nMet at the conference.\n\n${adaBlock}\n`,
    )
  })

  it('fills an empty body without leading blank lines', () => {
    expect(appendContactDetails('', ada)).toBe(`${adaBlock}\n`)
  })

  it('preserves frontmatter byte-for-byte', () => {
    const source = '---\nprivate: true\n---\nBody line.\n'
    expect(appendContactDetails(source, ada)).toBe(
      `---\nprivate: true\n---\nBody line.\n\n${adaBlock}\n`,
    )
  })

  it('is a no-op for a contact with no details', () => {
    const source = '# Ada Lovelace\n'
    expect(appendContactDetails(source, contact({}))).toBe(source)
  })

  it('does not stack a second typing line on an already-typed person note', () => {
    // The meeting flow and the link menu create person notes with a
    // `- Type: #person` body; Add must append only the details.
    const source = '# Ada Lovelace\n\n- Type: #person\n'
    expect(appendContactDetails(source, ada)).toBe(
      '# Ada Lovelace\n\n- Type: #person\n\n- Email: ada@example.com\n- Phone: +1 555 0100\n',
    )
  })
})

describe('noteHasContactDetails', () => {
  it('detects an email address anywhere in the body', () => {
    expect(noteHasContactDetails('Reach me at ada@example.com sometime.')).toBe(true)
  })

  it('detects Email/Phone field bullets with any list marker and case', () => {
    expect(noteHasContactDetails('- Email: pending\n')).toBe(true)
    expect(noteHasContactDetails('+ phone: +1 555 0100\n')).toBe(true)
    expect(noteHasContactDetails('  * Phone: unknown\n')).toBe(true)
  })

  it('stays quiet for ordinary prose, headings, and links', () => {
    expect(noteHasContactDetails('# Ada Lovelace\n\nMet at the conference.\n')).toBe(false)
    expect(noteHasContactDetails('- Type: #person\n')).toBe(false)
    expect(noteHasContactDetails('Emailing later about phones.\n')).toBe(false)
  })
})
