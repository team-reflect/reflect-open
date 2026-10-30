import { describe, expect, it } from 'vitest'
import { formatFileStamp, parseFileStamp } from './file-stamp.ts'

describe('file stamps', () => {
  it('round-trips a local moment', () => {
    const stamp = formatFileStamp(new Date(2026, 5, 12, 15, 30, 22, 845))
    expect(stamp).toBe('2026-06-12-153022-845')
    expect(parseFileStamp(stamp)).toEqual({ date: '2026-06-12', time: '15:30:22' })
  })

  it('rejects a stamp that names no real moment', () => {
    expect(parseFileStamp('2026-02-31-153022-845')).toBeNull()
    expect(parseFileStamp('2026-06-12-243022-845')).toBeNull()
    expect(parseFileStamp('2026-06-12-156022-845')).toBeNull()
  })
})
