import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { ConnectHostFields } from '@/components/settings/connect-host-fields.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { useConnectHost } from '@/hooks/use-connect-host.ts'

interface ConnectHostDialogProps {
  /**
   * The remote to prefill: an HTTPS remote that needs a sign-in. Empty for
   * a new connection.
   */
  remoteUrl?: string | undefined
  onClose: () => void
}

/**
 * The desktop "Another host" dialog: connect this graph to a GitLab, Gitea,
 * Codeberg or self-hosted repository over HTTPS with a username and an
 * access token. The host answers before anything is stored, so a wrong URL
 * or token fails here, inline.
 */
export function ConnectHostDialog({ remoteUrl, onClose }: ConnectHostDialogProps): ReactElement {
  const form = useConnectHost(remoteUrl ?? '')
  const updating = remoteUrl !== undefined

  async function submit(): Promise<void> {
    if (await form.submit()) {
      onClose()
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen && !form.pending) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={!form.pending} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{updating ? 'Update sign-in' : 'Connect another host'}</DialogTitle>
          <DialogDescription>
            {updating
              ? 'Enter the username and access token for this repository.'
              : 'Sync this graph with a repository on GitLab, Gitea, Codeberg or a server of your own.'}
          </DialogDescription>
        </DialogHeader>
        <ConnectHostFields form={form} onSubmit={() => void submit()} />
        {form.error !== null ? <InlineAlert tone="error">{form.error}</InlineAlert> : null}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="ghost" size="sm" disabled={form.pending}>
                Cancel
              </Button>
            }
          />
          <Button size="sm" disabled={form.pending} onClick={() => void submit()}>
            {form.pending ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
