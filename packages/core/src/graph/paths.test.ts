import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  assetPath,
  audioMemoPath,
  classifyGraphPath,
  dailyPath,
  dateFromDailyPath,
  foldGraphPath,
  isAttachmentPath,
  isCalendarDate,
  isDaily,
  isNotePath,
  isSafeVisibleGraphPath,
  isTemplatePath,
  mayContainNotes,
  notePath,
  templatePath,
} from './paths'

const fixtureSchema = z.array(
  z.object({
    path: z.string(),
    kind: z.enum(['note', 'attachment']).nullable(),
  }),
)

const classificationFixtures = fixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../../fixtures/graph-path-classification.json', import.meta.url),
      'utf8',
    ),
  ),
)

describe('graph paths', () => {
  it('builds daily-note paths from ISO dates', () => {
    expect(dailyPath('2026-06-09')).toBe('daily/2026-06-09.md')
  })

  it('rejects non-ISO daily dates', () => {
    expect(() => dailyPath('June 9 2026')).toThrow()
    expect(() => dailyPath('2026-6-9')).toThrow()
  })

  it('rejects well-formatted but invalid calendar dates', () => {
    expect(() => dailyPath('2026-13-01')).toThrow()
    expect(() => dailyPath('2026-02-31')).toThrow()
  })

  it('builds note, template, asset, and recording paths', () => {
    expect(notePath('charlotte-maccaw')).toBe('notes/charlotte-maccaw.md')
    expect(templatePath('journal')).toBe('templates/journal.md')
    expect(assetPath('screenshot.png')).toBe('assets/screenshot.png')
    expect(audioMemoPath('memo.m4a')).toBe('audio-memos/memo.m4a')
  })

  it('recognizes indexable Markdown anywhere outside hidden and reserved trees', () => {
    expect(isNotePath('notes/a.md')).toBe(true)
    expect(isNotePath('daily/2026-06-12.md')).toBe(true)
    expect(isNotePath('notes/sub/deep.md')).toBe(true)
    expect(isNotePath('templates/journal.md')).toBe(true)
    expect(isNotePath('README.md')).toBe(true)
    expect(isNotePath('Projects/Plan.md')).toBe(true)
    expect(isNotePath('notes/a.txt')).toBe(false)
    expect(isNotePath('audio-memos/audio-memo-2026-06-12-090000-000.m4a')).toBe(false)
    expect(isNotePath('assets/pasted.png')).toBe(false)
    expect(isNotePath('assets/caption.md')).toBe(false)
    expect(isNotePath('.obsidian/note.md')).toBe(false)
    expect(isNotePath('Projects/.private/note.md')).toBe(false)
    expect(isNotePath('Projects/Plan.MD')).toBe(false)
  })

  it('matches the shared Rust classification corpus', () => {
    for (const fixture of classificationFixtures) {
      expect(classifyGraphPath(fixture.path), fixture.path).toBe(fixture.kind)
    }
  })

  it('recognizes supported attachments case-insensitively', () => {
    expect(isAttachmentPath('assets/photo.png')).toBe(true)
    expect(isAttachmentPath('Media/PHOTO.JPEG')).toBe(true)
    expect(isAttachmentPath('Documents/reference.pdf')).toBe(true)
    expect(isAttachmentPath('Documents/archive.zip')).toBe(true)
    expect(isAttachmentPath('Documents/report.docx')).toBe(true)
    expect(isAttachmentPath('assets/notes.txt')).toBe(true)
    // Executable and script formats stay out of the whitelist.
    expect(isAttachmentPath('tools/script.sh')).toBe(false)
    expect(isAttachmentPath('tools/binary.exe')).toBe(false)
    // ASCII-only folding: KELVIN SIGN lowercases to "k" in Unicode but the
    // Rust side never folds beyond ASCII, so both sides must reject it.
    expect(isAttachmentPath('Media/clip.m\u{212A}v')).toBe(false)
  })

  it('rejects hidden, traversal, absolute, and non-normalized paths', () => {
    expect(isSafeVisibleGraphPath('Projects/Plan.md')).toBe(true)
    expect(isSafeVisibleGraphPath('.hidden.md')).toBe(false)
    expect(isSafeVisibleGraphPath('Projects/../outside.md')).toBe(false)
    expect(isSafeVisibleGraphPath('/absolute.md')).toBe(false)
    expect(isSafeVisibleGraphPath('C:/absolute.md')).toBe(false)
    expect(isSafeVisibleGraphPath('C:relative.md')).toBe(false)
    expect(isSafeVisibleGraphPath('Projects//Plan.md')).toBe(false)
    expect(isSafeVisibleGraphPath(String.raw`Projects\Plan.md`)).toBe(false)
  })

  it('prunes hidden and reserved root trees from note traversal', () => {
    expect(mayContainNotes('Projects')).toBe(true)
    expect(mayContainNotes('assets')).toBe(false)
    expect(mayContainNotes('audio-memos/archive')).toBe(false)
    expect(mayContainNotes('.obsidian')).toBe(false)
  })

  it('recognizes template paths', () => {
    expect(isTemplatePath('templates/journal.md')).toBe(true)
    expect(isTemplatePath('templates/journal.txt')).toBe(false)
    expect(isTemplatePath('notes/journal.md')).toBe(false)
  })

  it('recognizes daily-note paths', () => {
    expect(isDaily('daily/2026-06-09.md')).toBe(true)
    expect(isDaily('notes/foo.md')).toBe(false)
    expect(isDaily('daily/not-a-date.md')).toBe(false)
  })

  it('extracts the date from a daily path, else null', () => {
    expect(dateFromDailyPath('daily/2026-06-09.md')).toBe('2026-06-09')
    expect(dateFromDailyPath('notes/foo.md')).toBeNull()
  })
})

describe('isCalendarDate', () => {
  it('accepts a real date and rejects an impossible one', () => {
    expect(isCalendarDate('2026-07-26')).toBe(true)
    // No Date.UTC two-digit-year remap: year 99 is year 99, and proleptic
    // year 0 is a leap year (divisible by 400) even though 1900 is not.
    expect(isCalendarDate('0099-12-31')).toBe(true)
    expect(isCalendarDate('0000-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-29')).toBe(false)
    expect(isCalendarDate('2026-02-31')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
    expect(isCalendarDate('not-a-date')).toBe(false)
  })
})

describe('foldGraphPath', () => {
  it('lowers ASCII only, never the full Unicode fold', () => {
    expect(foldGraphPath('Projects/Plan.MD')).toBe('projects/plan.md')
    // NFC's singleton mappings apply (KELVIN SIGN decomposes to K, then the
    // ASCII fold lowers it) — safe because every comparand passes through
    // this same fold. What must NOT happen is toLowerCase-style folding of
    // characters NFC leaves alone.
    expect(foldGraphPath('\u{212A}.md')).toBe('k.md')
    expect(foldGraphPath('\u{130}.md')).toBe('\u{130}.md')
  })

  it('normalizes NFD to NFC before folding', () => {
    expect(foldGraphPath('Cafe\u{301}.md')).toBe('caf\u{E9}.md')
  })
})
