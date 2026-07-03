import { useMemo, type ReactElement, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import { canReadCalendars, requestCalendarAccess, type CalendarInfo } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { isMacosDesktop } from '@/lib/platform'
import {
  CALENDAR_QUERY_PREFIX,
  useCalendarAuthorization,
  useCalendarChangeInvalidation,
  useCalendars,
} from '@/lib/use-calendar'
import { useSettings } from '@/providers/settings-provider'
import { SettingsSwitchField } from './switch-field'

/** The macOS privacy pane where a revoked calendar grant is flipped back on. */
const CALENDAR_PRIVACY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'

const ACTION_BUTTON_CLASS =
  'rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover'

/**
 * The calendar integration field (docs/porting/calendar-meetings-integration.md):
 * one switch, then a compact calendar count with the full per-calendar
 * chooser in a dialog. There are no credentials here and none to go stale:
 * macOS Calendar owns the accounts (Google, iCloud, Exchange), so a denied
 * or revoked grant shows one explanation with a System Settings button, not
 * an error-badge-and-reconnect loop. macOS-only; the field renders nothing
 * elsewhere.
 */
export function CalendarIntegrationField(): ReactElement | null {
  const { settings, updateSettings, updateSettingsWith } = useSettings()
  const queryClient = useQueryClient()
  const status = useCalendarAuthorization(settings.calendarEnabled)
  const canRead = status !== undefined && canReadCalendars(status)
  const { calendars, isLoaded } = useCalendars(settings.calendarEnabled && canRead)
  useCalendarChangeInvalidation(settings.calendarEnabled)

  const groups = useMemo(() => {
    const bySource = new Map<string, CalendarInfo[]>()
    for (const calendar of calendars) {
      const group = bySource.get(calendar.source)
      if (group) {
        group.push(calendar)
      } else {
        bySource.set(calendar.source, [calendar])
      }
    }
    return [...bySource.entries()]
  }, [calendars])

  if (!isMacosDesktop) {
    return null
  }

  const requestAccess = (): void => {
    // Resolves instantly when the OS already remembers an answer; prompts
    // only on the very first request. Either way the queries re-check.
    void requestCalendarAccess()
      .catch((cause: unknown) => {
        console.error('calendar access request failed:', cause)
      })
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: CALENDAR_QUERY_PREFIX })
      })
  }

  const handleToggle = (checked: boolean): void => {
    updateSettings({ calendarEnabled: checked })
    if (checked) {
      requestAccess()
    }
  }

  const toggleCalendar = (id: string, checked: boolean): void => {
    updateSettingsWith((current) => ({
      calendarIds: checked
        ? [...current.calendarIds.filter((existing) => existing !== id), id]
        : current.calendarIds.filter((existing) => existing !== id),
    }))
  }

  let detail: ReactNode = null
  if (settings.calendarEnabled && status !== undefined && !canRead) {
    detail = (
      <div>
        <InlineAlert tone="error">
          {status === 'notDetermined'
            ? 'Reflect needs permission to read your calendars.'
            : 'Reflect can’t read your calendars. Allow it under Privacy & Security → Calendars.'}
        </InlineAlert>
        <div className="mt-2">
          {status === 'notDetermined' ? (
            <button type="button" onClick={requestAccess} className={ACTION_BUTTON_CLASS}>
              Grant access
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                void openUrl(CALENDAR_PRIVACY_PANE).catch((cause: unknown) => {
                  console.error('failed to open System Settings:', cause)
                })
              }}
              className={ACTION_BUTTON_CLASS}
            >
              Open System Settings
            </button>
          )}
        </div>
      </div>
    )
  } else if (settings.calendarEnabled && canRead && isLoaded) {
    // Count only ids the Mac still knows — settings may hold identifiers
    // from since-removed accounts, and "3/2 calendars" would be nonsense.
    const enabledCount = calendars.filter((calendar) =>
      settings.calendarIds.includes(calendar.id),
    ).length
    detail =
      groups.length === 0 ? (
        <p className="text-xs text-text-muted">
          No calendars found. Add accounts in System Settings → Internet Accounts.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-text-muted">
            {enabledCount}/{calendars.length} calendars selected
          </p>
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                Choose calendars…
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Choose calendars</DialogTitle>
                <DialogDescription>
                  Select the calendars Reflect shows beside your daily note.
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[min(28rem,70vh)] overflow-y-auto pr-1">
                <div className="space-y-4">
                  {groups.map(([source, group]) => (
                    <div key={source}>
                      <p className="text-2xs font-medium text-text-muted">{source}</p>
                      <ul className="mt-2 space-y-2">
                        {group.map((calendar) => (
                          <li key={calendar.id}>
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
                              <Checkbox
                                checked={settings.calendarIds.includes(calendar.id)}
                                onCheckedChange={(checked) =>
                                  toggleCalendar(calendar.id, checked === true)
                                }
                                aria-label={calendar.title}
                              />
                              {calendar.color !== null && (
                                <span
                                  aria-hidden
                                  className="size-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: calendar.color }}
                                />
                              )}
                              <span className="truncate">{calendar.title}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
              <DialogFooter showCloseButton />
            </DialogContent>
          </Dialog>
        </div>
      )
  }

  return (
    <div>
      <SettingsSwitchField
        legend="Calendar events"
        description="Show the day's meetings from Apple Calendar beside the daily note."
        checked={settings.calendarEnabled}
        onCheckedChange={handleToggle}
      />
      {detail !== null && <div className="px-4 pb-3.5">{detail}</div>}
    </div>
  )
}
