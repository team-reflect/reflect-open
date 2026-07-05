import { useEffect, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import {
  addMeetingToDaily,
  contactsAuthorizationStatus,
  defaultAttendees,
  errorMessage,
  isContactsReadable,
  resolveMeetingAttendees,
  type CalendarEvent,
  type MeetingAttendee,
} from '@reflect/core'
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
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatTimeOfDay } from '@/lib/dates'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import { AttendeeCombobox } from './attendee-combobox'

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
  const { graph } = useGraph()
  const [name, setName] = useState(event.title)
  const [attendees, setAttendees] = useState<MeetingAttendee[]>(() => defaultAttendees(event))
  const [createNote, setCreateNote] = useState(event.recurring)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The dialog is conditionally mounted by its parent, bypassing Radix's
  // onCloseAutoFocus path — restore the opener's focus on unmount ourselves.
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement) {
        opener.focus()
      }
    }
  }, [])

  // Upgrade the prefilled chips once attendee resolution answers: an invite
  // email an existing note owns swaps the calendar's spelling for the note
  // title, so the chip shows exactly what submit will link. Chips are merged
  // by their prefill name — anything the user removed stays removed, anything
  // they added is untouched. Submit re-resolves authoritatively either way,
  // so a failure (or a submit that beats this) only costs display polish.
  useEffect(() => {
    let cancelled = false
    const upgradeAttendees = async (): Promise<void> => {
      const lookupContacts =
        settings.contactsEnabled && isContactsReadable(await contactsAuthorizationStatus())
      const prefilled = defaultAttendees(event)
      const resolved = await resolveMeetingAttendees(prefilled, lookupContacts)
      if (cancelled) {
        return
      }
      const upgrades = new Map(
        prefilled.map((original, index) => [original.name, resolved[index] ?? original]),
      )
      setAttendees((current) => {
        const seen = new Set<string>()
        const merged: MeetingAttendee[] = []
        for (const attendee of current) {
          const upgraded = upgrades.get(attendee.name) ?? attendee
          const key = upgraded.name.toLowerCase()
          if (seen.has(key)) {
            continue
          }
          seen.add(key)
          merged.push(upgraded)
        }
        return merged
      })
    }
    upgradeAttendees().catch((cause: unknown) => {
      console.error('attendee resolution failed:', cause)
    })
    return () => {
      cancelled = true
    }
  }, [event, settings.contactsEnabled])

  const addAttendee = (attendee: MeetingAttendee): void => {
    setAttendees((current) =>
      current.some((existing) => existing.name.toLowerCase() === attendee.name.toLowerCase())
        ? current
        : [...current, attendee],
    )
  }

  const removeAttendee = (attendeeName: string): void => {
    setAttendees((current) => current.filter((existing) => existing.name !== attendeeName))
  }

  const canSubmit = graph !== null && name.trim() !== '' && !submitting

  const submit = async (): Promise<void> => {
    if (graph === null) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // The permission state is read at submit time, not dialog mount — the
      // cached query may still be in flight (or stale after a System
      // Settings trip), and a quick submit must not skip the pre-fill.
      const lookupContacts =
        settings.contactsEnabled && isContactsReadable(await contactsAuthorizationStatus())
      await addMeetingToDaily({
        date,
        title: name,
        attendees,
        backlinkMeeting: createNote,
        lookupContacts,
        startTime: formatTimeOfDay(new Date(event.startsAt), settings.timeFormat),
        generation: graph.generation,
      })
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
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
        <form
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault()
            void submit()
          }}
          className="space-y-4"
        >
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
            <Button type="button" variant="outline" onClick={onClose}>
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
