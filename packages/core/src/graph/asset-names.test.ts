import { describe, expect, it } from 'vitest'
import { assetFileName } from './asset-names'

describe('assetFileName', () => {
  it('slugs the stem and keeps a lowercased extension', () => {
    expect(assetFileName('Q3 Report (final).PDF')).toBe('q3-report-final.pdf')
    expect(assetFileName('My Résumé.docx')).toBe('my-résumé.docx')
  })

  it('turns inner dots into dashes instead of dropping them', () => {
    expect(assetFileName('archive.tar.gz')).toBe('archive-tar.gz')
    expect(assetFileName('v1.2.3 release notes.txt')).toBe('v1-2-3-release-notes.txt')
  })

  it('treats a leading dot as part of the stem, not an extension', () => {
    expect(assetFileName('.env')).toBe('env')
    expect(assetFileName('.gitignore')).toBe('gitignore')
  })

  it('handles extensionless names', () => {
    expect(assetFileName('README')).toBe('readme')
    expect(assetFileName('Makefile')).toBe('makefile')
  })

  it('never returns an empty or Windows-reserved name', () => {
    expect(assetFileName('???')).toBe('untitled')
    expect(assetFileName('🎉🎉.pdf')).toBe('untitled.pdf')
    expect(assetFileName('CON.pdf')).toBe('con-note.pdf')
  })

  it('strips junk from the extension and caps its length', () => {
    expect(assetFileName('weird.p d f')).toBe('weird.pdf')
    expect(assetFileName('file.verylongextensionxxxx')).toBe('file.verylongexte')
  })

  it('is idempotent on already-sanitized names', () => {
    expect(assetFileName('q3-report.pdf')).toBe('q3-report.pdf')
  })
})
