import { describe, expect, it } from 'vitest'
import {
  assetPath,
  audioMemoPath,
  dailyPath,
  dateFromDailyPath,
  isDaily,
  isNotePath,
  isTemplatePath,
  notePath,
  templatePath,
} from './paths'

describe('graph paths', () => {
  it('builds daily-note paths from ISO dates', () => {
    expect(dailyPath('2026-06-09')).toBe('journal/2026-06-09.md')
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

  it('recognizes indexable note paths, never recordings or assets', () => {
    expect(isNotePath('notes/a.md')).toBe(true)
    expect(isNotePath('journal/2026-06-12.md')).toBe(true)
    expect(isNotePath('notes/sub/deep.md')).toBe(true)
    expect(isNotePath('templates/journal.md')).toBe(true)
    expect(isNotePath('notes/a.txt')).toBe(false)
    expect(isNotePath('audio-memos/audio-memo-2026-06-12-090000-000.m4a')).toBe(false)
    expect(isNotePath('assets/pasted.png')).toBe(false)
    expect(isNotePath('README.md')).toBe(false)
  })

  it('recognizes template paths', () => {
    expect(isTemplatePath('templates/journal.md')).toBe(true)
    expect(isTemplatePath('templates/journal.txt')).toBe(false)
    expect(isTemplatePath('notes/journal.md')).toBe(false)
  })

  it('recognizes daily-note paths', () => {
    expect(isDaily('journal/2026-06-09.md')).toBe(true)
    expect(isDaily('notes/foo.md')).toBe(false)
    expect(isDaily('journal/not-a-date.md')).toBe(false)
  })

  it('extracts the date from a daily path, else null', () => {
    expect(dateFromDailyPath('journal/2026-06-09.md')).toBe('2026-06-09')
    expect(dateFromDailyPath('notes/foo.md')).toBeNull()
  })
})
