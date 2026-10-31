import { describe, expect, it } from 'vitest'
import { updatedPresetFilter } from './all-notes-filters.ts'

describe('updatedPresetFilter', () => {
  it('resolves presets to local day starts relative to now', () => {
    const now = new Date(2026, 5, 15, 14, 30)
    expect(updatedPresetFilter('today', now)).toEqual({
      label: 'Today',
      afterMs: new Date(2026, 5, 15).getTime(),
      beforeMs: null,
    })
    expect(updatedPresetFilter('week', now).afterMs).toBe(new Date(2026, 5, 9).getTime())
    expect(updatedPresetFilter('month', now).afterMs).toBe(new Date(2026, 4, 17).getTime())
  })
})
