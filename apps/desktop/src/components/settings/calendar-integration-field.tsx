import { useMemo, type ReactElement, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { countSelectedCalendars, groupCalendarsBySource } from '@reflect/app'
import { canReadCalendars } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.tsx'
import { queryKeys } from '@/lib/query-client.ts'
import {
  useCalendarAuthorization,
  useCalendarChangeInvalidation,
  useCalendars,
} from '@/lib/use-calendar.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'
import { SettingsSwitchField } from './switch-field.tsx'

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
  const { settings } = useSettings()
  const queryClient = useQueryClient()
  const { opener, calendarEvents } = useAppServices()
  const status = useCalendarAuthorization(settings.calendarEnabled)
  const canRead = status !== undefined && canReadCalendars(status)
  const { calendars, isLoaded } = useCalendars(settings.calendarEnabled && canRead)
  useCalendarChangeInvalidation(settings.calendarEnabled)

  const groups = useMemo(() => groupCalendarsBySource(calendars), [calendars])

  if (!calendarEvents.isAvailable()) {
    return null
  }

  const recheck = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all })
  }

  const requestAccess = (): void => {
    // Resolves instantly when the OS already remembers an answer; prompts
    // only on the very first request. Either way the queries re-check.
    void calendarEvents.requestAccess().finally(recheck)
  }

  const handleToggle = (checked: boolean): void => {
    void calendarEvents.setEnabled(checked).then(({ accessRequested }) => {
      if (accessRequested) {
        recheck()
      }
    })
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
                opener.openSystemSettings('calendar')
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
    const enabledCount = countSelectedCalendars(calendars, settings.calendarIds)
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
            <DialogTrigger
              render={
                <Button type="button" variant="outline" size="sm">
                  Choose calendars…
                </Button>
              }
            />
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
                                onCheckedChange={(checked) => {
                                  calendarEvents.toggleCalendar(calendar.id, checked === true)
                                }}
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
