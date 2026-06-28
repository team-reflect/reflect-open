import type { ReactElement } from 'react'
import {
  dateFormatSchema,
  timeFormatSchema,
  weekStartDaySchema,
  type DateFormat,
  type TimeFormat,
  type WeekStartDay,
} from '@reflect/core'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatFullDate } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'
import { SettingsField } from './field'
import { SettingsSection } from './section'

interface TimeFormatOption {
  value: TimeFormat
  label: string
}

interface WeekStartOption {
  value: WeekStartDay
  label: string
}

const TIME_FORMAT_OPTIONS: TimeFormatOption[] = [
  { value: '12h', label: '12-hour' },
  { value: '24h', label: '24-hour' },
]

const WEEK_START_OPTIONS: WeekStartOption[] = [
  { value: 'monday', label: 'Monday' },
  { value: 'sunday', label: 'Sunday' },
]

// The options demonstrate themselves: each shows today's date in its format,
// so the day/month order is visible rather than described.
const DATE_FORMAT_VALUES: DateFormat[] = ['mdy', 'dmy', 'iso']

/**
 * Date & time display preferences. Both formats feed every date and time the
 * app renders (via `formatDayLabel`/`formatTimeOfDay`/`formatRecencyLabel` in
 * `lib/dates.ts`) — display-only, so switching them never touches stored
 * timestamps or daily-note keys.
 */
export function DateTimeSection(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const today = new Date()

  return (
    <SettingsSection id="date-time">
      <SettingsField
        legend="Date format"
        description="The style for dates shown throughout Reflect, including daily note titles."
      >
        <div className="mt-3">
          <Select
            value={settings.dateFormat}
            onValueChange={(value) => updateSettings({ dateFormat: dateFormatSchema.parse(value) })}
          >
            <SelectTrigger aria-label="Date format" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_FORMAT_VALUES.map((value) => (
                <SelectItem key={value} value={value}>
                  {formatFullDate(today, value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsField>
      <SettingsField
        legend="Start week on"
        description="The first day shown in calendars."
      >
        <div className="mt-3">
          <Select
            value={settings.weekStartDay}
            onValueChange={(value) =>
              updateSettings({ weekStartDay: weekStartDaySchema.parse(value) })
            }
          >
            <SelectTrigger aria-label="Start week on" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEK_START_OPTIONS.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsField>
      <SettingsField
        legend="Time format"
        description="How times are shown throughout Reflect — 8:22pm or 20:22."
      >
        <div className="mt-3">
          <Select
            value={settings.timeFormat}
            onValueChange={(value) => updateSettings({ timeFormat: timeFormatSchema.parse(value) })}
          >
            <SelectTrigger aria-label="Time format" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_FORMAT_OPTIONS.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsField>
    </SettingsSection>
  )
}
