import { describe, expect, it } from 'vitest'
import { privacyFingerprintFromNotes } from './privacy-fingerprint'

describe('privacyFingerprintFromNotes', () => {
  it('is stable across scan order and public-note content changes', async () => {
    const first = await privacyFingerprintFromNotes([
      { path: 'public.md', source: '# Public' },
      { path: 'private.md', source: '---\nprivate: true\n---\nsecret' },
    ])
    const reordered = await privacyFingerprintFromNotes([
      { path: 'private.md', source: '---\nprivate: true\n---\nchanged secret' },
      { path: 'public.md', source: '# Changed public body' },
    ])
    expect(reordered).toBe(first)
  })

  it('changes when a public note becomes private', async () => {
    const publicFingerprint = await privacyFingerprintFromNotes([
      { path: 'note.md', source: '# Public' },
    ])
    const privateFingerprint = await privacyFingerprintFromNotes([
      { path: 'note.md', source: '\uFEFF---\rprivate: true\r---\rsecret' },
    ])
    expect(privateFingerprint).not.toBe(publicFingerprint)
  })

  it('includes malformed and unterminated frontmatter paths conservatively', async () => {
    const publicFingerprint = await privacyFingerprintFromNotes([])
    const malformedFingerprint = await privacyFingerprintFromNotes([
      { path: 'malformed.md', source: '---\nprivate: [\n---\nbody' },
    ])
    const unterminatedFingerprint = await privacyFingerprintFromNotes([
      { path: 'unterminated.md', source: '\uFEFF---\rprivate: false\rbody' },
    ])
    expect(malformedFingerprint).not.toBe(publicFingerprint)
    expect(unterminatedFingerprint).not.toBe(publicFingerprint)
  })
})
