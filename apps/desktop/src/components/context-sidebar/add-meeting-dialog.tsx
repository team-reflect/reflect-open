import { useEffect, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import {
  addMeetingToDaily,
  defaultAttendeeNames,
  errorMessage,
  type CalendarEvent,
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
import { createNoteWithTitle } from '@/lib/create-note'
import { formatTimeOfDay } from '@/lib/dates'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

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
 * list, and the create-backlinked-note choice (defaulted on for recurring
 * events, as v1 did — a recurring meeting's shared note is where its notes
 * accumulate). Submitting writes `- [[Meeting]] with [[Person]]…` under the
 * daily note's `## Meetings` heading and creates missing notes; after that
 * nothing stays tied to the calendar.
 */
export function AddMeetingDialog({ date, event, onClose }: AddMeetingDialogProps): ReactElement {
  const { settings } = useSettings()
  const { graph } = useGraph()
  const [name, setName] = useState(event.title)
  const [attendees, setAttendees] = useState<string[]>(() => defaultAttendeeNames(event))
  const [newAttendee, setNewAttendee] = useState('')
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

  const addAttendee = (): void => {
    const attendee = newAttendee.trim()
    if (attendee === '') {
      return
    }
    setAttendees((current) =>
      current.some((existing) => existing.toLowerCase() === attendee.toLowerCase())
        ? current
        : [...current, attendee],
    )
    setNewAttendee('')
  }

  const removeAttendee = (attendee: string): void => {
    setAttendees((current) => current.filter((existing) => existing !== attendee))
  }

  const canSubmit = graph !== null && name.trim() !== '' && !submitting

  const submit = async (): Promise<void> => {
    if (graph === null) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await addMeetingToDaily({
        date,
        title: name,
        attendees,
        createMeetingNote: createNote,
        generation: graph.generation,
        createNote: createNoteWithTitle,
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
          <DialogTitle>Add to daily note</DialogTitle>
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
            <label htmlFor="add-meeting-attendee" className={FIELD_LABEL_CLASS}>
              Attendees
            </label>
            {attendees.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {attendees.map((attendee) => (
                  <li
                    key={attendee}
                    className="flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5 text-xs text-text-secondary"
                  >
                    <span className="max-w-40 truncate">{attendee}</span>
                    <button
                      type="button"
                      onClick={() => removeAttendee(attendee)}
                      aria-label={`Remove ${attendee}`}
                      className="text-text-muted transition-colors hover:text-text"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Input
              id="add-meeting-attendee"
              value={newAttendee}
              onChange={(changeEvent) => setNewAttendee(changeEvent.target.value)}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'Enter') {
                  keyEvent.preventDefault()
                  addAttendee()
                }
              }}
              onBlur={addAttendee}
              placeholder="Add attendee"
            />
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
