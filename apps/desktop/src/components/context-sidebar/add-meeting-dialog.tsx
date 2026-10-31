import { useActionState, useEffect, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
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
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import {
  defaultAttendees,
  errorMessage,
  mergeAttendeeUpgrades,
  withAttendee,
  type CalendarEvent,
  type MeetingAttendee,
  formatTimeOfDay,
} from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { AttendeeCombobox } from './attendee-combobox.tsx'

interface AddMeetingDialogProps {
  /** The daily note receiving the entry — a validated ISO date. */
  date: string
  /** The calendar event being added; prefills the form. */
  event: CalendarEvent
  onClose: () => void
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * v1's "Add event" modal: an editable meeting name, an editable attendee
 * list (with note/contact autocomplete — {@link AttendeeCombobox}), and the
 * create-backlinked-note choice (defaulted on for recurring events, as v1
 * did — a recurring meeting's shared note is where its notes accumulate).
 * Submitting writes `- [[Meeting]] with [[Person]]…` under the daily note's
 * `## Meetings` heading and creates missing notes; after that nothing stays
 * tied to the calendar. With the contacts integration on, fresh person notes
 * are pre-filled from Apple Contacts by attendee email.
 */
export function AddMeetingDialog({ date, event, onClose }: AddMeetingDialogProps): ReactElement {
  const { settings } = useSettings()
  const { contacts, meetings, logger, graphSession } = useCoreServices()
  const [name, setName] = useState(event.title)
  const [attendees, setAttendees] = useState<MeetingAttendee[]>(() => defaultAttendees(event))
  const [createNote, setCreateNote] = useState(event.recurring)

  // Upgrade the prefilled chips once attendee resolution answers: an invite
  // email an existing note owns swaps the calendar's spelling for the note
  // title, so the chip shows exactly what submit will link. Chips are merged
  // by their prefill name — anything the user removed stays removed, anything
  // they added is untouched. Submit re-resolves authoritatively either way,
  // so a failure (or a submit that beats this) only costs display polish.
  useEffect(() => {
    let cancelled = false
    const upgradeAttendees = async (): Promise<void> => {
      const upgrades = await meetings.resolvePrefilledAttendees(defaultAttendees(event))
      if (cancelled) {
        return
      }
      setAttendees((current) => mergeAttendeeUpgrades(current, upgrades))
    }
    upgradeAttendees().catch((cause: unknown) => {
      logger.error('attendee resolution failed:', cause)
    })
    return () => {
      cancelled = true
    }
  }, [event, logger, meetings, settings.contactsEnabled])

  const addAttendee = (attendee: MeetingAttendee): void => {
    setAttendees((current) => withAttendee(current, attendee))
  }

  const removeAttendee = (attendeeName: string): void => {
    setAttendees((current) => current.filter((existing) => existing.name !== attendeeName))
  }

  // The form action returns the inline error (or `null`), so a retry clears
  // the previous one. Success closes the dialog from inside the action.
  const [error, submitAction, submitting] = useActionState(
    async (previous: string | null): Promise<string | null> => {
      const { session } = graphSession.getState()
      if (session === null) {
        return previous
      }
      try {
        // The permission state is re-read at submit time, not dialog mount: it
        // may be stale after a System Settings trip, and a quick submit must
        // not skip the pre-fill.
        await contacts.refresh()
        if (graphSession.getState().session !== session) {
          onClose()
          return null
        }
        const lookupContacts = meetings.canLookupContacts()
        await meetings.addMeetingToDaily({
          date,
          title: name,
          attendees,
          backlinkMeeting: createNote,
          lookupContacts,
          startTime: formatTimeOfDay(new Date(event.startsAt), settings.timeFormat),
        })
      } catch (cause) {
        return errorMessage(cause)
      }
      onClose()
      return null
    },
    null,
  )

  const canSubmit = name.trim() !== '' && !submitting

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        // Not while submitting: the in-flight submit still writes the meeting
        // and calls `onClose` when it settles.
        if (!isOpen && !submitting) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add event</DialogTitle>
          <DialogDescription>
            {formatTimeOfDay(new Date(event.startsAt), settings.timeFormat)}
          </DialogDescription>
        </DialogHeader>
        <form action={submitAction} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="add-meeting-name" className={FIELD_LABEL_CLASS}>
              Meeting name
            </label>
            <Input
              id="add-meeting-name"
              value={name}
              onChange={(changeEvent) => setName(changeEvent.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            {/* The combobox input's real label is cmdk's hidden one (same
                text); an htmlFor can't reach a cmdk input. */}
            <div aria-hidden className={FIELD_LABEL_CLASS}>
              Attendees
            </div>
            {attendees.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {attendees.map((attendee) => (
                  <li
                    key={attendee.name}
                    className="flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5 text-xs text-text-secondary"
                  >
                    <span className="max-w-40 truncate">{attendee.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttendee(attendee.name)}
                      aria-label={`Remove ${attendee.name}`}
                      className="text-text-muted transition-colors hover:text-text"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <AttendeeCombobox attendees={attendees} onAdd={addAttendee} />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
            <Checkbox
              checked={createNote}
              onCheckedChange={(checked) => setCreateNote(checked === true)}
            />
            Create backlinked note
          </label>
          {error !== null && <InlineAlert tone="error">{error}</InlineAlert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Add to daily note
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
