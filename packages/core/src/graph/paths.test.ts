import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  assetPath,
  audioMemoPath,
  classifyGraphPath,
  dailyPath,
  dateFromDailyPath,
  isAttachmentPath,
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
    expect(isAttachmentPath('Documents/archive.zip')).toBe(false)
    // ASCII-only folding: KELVIN SIGN lowercases to "k" in Unicode but the
    // Rust side never folds beyond ASCII, so both sides must reject it.
    expect(isAttachmentPath('Media/clip.m\u212Av')).toBe(false)
  })

  it('rejects hidden, traversal, absolute, and non-normalized paths', () => {
    expect(isSafeVisibleGraphPath('Projects/Plan.md')).toBe(true)
    expect(isSafeVisibleGraphPath('.hidden.md')).toBe(false)
    expect(isSafeVisibleGraphPath('Projects/../outside.md')).toBe(false)
    expect(isSafeVisibleGraphPath('/absolute.md')).toBe(false)
    expect(isSafeVisibleGraphPath('C:/absolute.md')).toBe(false)
    expect(isSafeVisibleGraphPath('C:relative.md')).toBe(false)
    expect(isSafeVisibleGraphPath('Projects//Plan.md')).toBe(false)
    expect(isSafeVisibleGraphPath('Projects\\Plan.md')).toBe(false)
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
