import type { ReactElement } from 'react'
import type { CalendarEvent } from '@reflect/core'
import { createDeferredFeature } from '@/components/deferred-feature'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatTimeOfDay } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'

const AddMeetingForm = createDeferredFeature(
  async () => ({ default: (await import('./add-meeting-form')).AddMeetingForm }),
  { name: 'the event form' },
)

interface AddMeetingDialogProps {
  /** The daily note receiving the entry — a validated ISO date. */
  date: string
  /** The calendar event being added; prefills the form. */
  event: CalendarEvent
  onClose: () => void
}

/** Edit a calendar event and its attendees before adding it to the daily note. */
export function AddMeetingDialog({ date, event, onClose }: AddMeetingDialogProps): ReactElement {
  const { settings } = useSettings()

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
        <AddMeetingForm date={date} event={event} onClose={onClose} />
      </DialogContent>
    </Dialog>
  )
}
