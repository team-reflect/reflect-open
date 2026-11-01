import { addDaysToIsoDate, formatIsoDate, parseIsoDate } from '@reflect/utils'
/**
 * An updated-at constraint: resolved epoch-ms bounds plus the chip label.
 */
export interface UpdatedFilter {
  /**
   * What the badge shows while active ("Last 7 days", "Since Jun 1").
   */
  label: string
  /**
   * Inclusive lower bound on `mtime`, epoch ms, or null.
   */
  afterMs: number | null
  /**
   * Exclusive upper bound on `mtime`, epoch ms, or null.
   */
  beforeMs: number | null
}

/**
 * The updated-at badge's relative presets.
 */
export type UpdatedPreset = 'today' | 'week' | 'month'

export const UPDATED_PRESETS: readonly { preset: UpdatedPreset; label: string }[] = [
  { preset: 'today', label: 'Today' },
  { preset: 'week', label: 'Last 7 days' },
  { preset: 'month', label: 'Last 30 days' },
]

/**
 * Resolve a relative preset against `now` (injectable for tests).
 */
export function updatedPresetFilter(preset: UpdatedPreset, now: Date = new Date()): UpdatedFilter {
  const days = preset === 'today' ? 0 : preset === 'week' ? -6 : -29
  const label = UPDATED_PRESETS.find((entry) => entry.preset === preset)!.label
  return {
    label,
    afterMs: parseIsoDate(addDaysToIsoDate(formatIsoDate(now), days)).getTime(),
    beforeMs: null,
  }
}
