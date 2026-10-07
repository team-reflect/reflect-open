import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { ConnectHostFields } from '@/components/settings/connect-host-fields.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { useConnectHost } from '@/hooks/use-connect-host.ts'

interface ConnectHostDialogProps {
  onClose: () => void
}

/**
 * The desktop "Connect another host" dialog: a Dialog shell over
 * {@link useConnectHost}. The mobile drawer renders the same hook and
 * fields; flow changes belong in the hook, not here.
 */
export function ConnectHostDialog({ onClose }: ConnectHostDialogProps): ReactElement {
  const form = useConnectHost(onClose)

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
          <DialogTitle>Connect another host</DialogTitle>
          <DialogDescription>
            Back up this graph to a repository on GitLab, Gitea, Codeberg, or your own server, over
            HTTPS with a token.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void form.submit()
          }}
        >
          <ConnectHostFields form={form} autoFocus />
          <Button type="submit" size="sm" disabled={form.pending}>
            {form.pending ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
        {form.error !== null ? <InlineAlert tone="error">{form.error}</InlineAlert> : null}
      </DialogContent>
    </Dialog>
  )
}
