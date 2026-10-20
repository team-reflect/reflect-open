import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { ConnectHostFields } from '@/components/settings/connect-host-fields.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'
import { useConnectHost } from '@/hooks/use-connect-host.ts'

interface ConnectHostDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The remote to prefill: an HTTPS remote that needs a sign-in. */
  remoteUrl?: string | undefined
}

/**
 * The mobile "Connect another host" bottom sheet: a Drawer shell over
 * {@link useConnectHost}, the same form as desktop's dialog. The body mounts
 * per open cycle, so a dismissed half-filled form never leaks into the next.
 */
export function ConnectHostDrawer({
  open,
  onOpenChange,
  remoteUrl,
}: ConnectHostDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Connect another host">
        {open ? (
          <ConnectHostSheet remoteUrl={remoteUrl} onClose={() => onOpenChange(false)} />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function ConnectHostSheet({
  remoteUrl,
  onClose,
}: {
  remoteUrl: string | undefined
  onClose: () => void
}): ReactElement {
  const form = useConnectHost(remoteUrl ?? '')
  const updating = remoteUrl !== undefined

  async function submit(): Promise<void> {
    if (await form.submit()) {
      onClose()
    }
  }

  return (
    <>
      <DrawerTitle>{updating ? 'Update sign-in' : 'Connect another host'}</DrawerTitle>
      <DrawerBody>
        <p className="text-xs text-text-muted">
          {updating
            ? 'Enter the username and access token for this repository.'
            : 'Sync this graph with a repository on GitLab, Gitea, Codeberg or a server of your own.'}
        </p>
        <ConnectHostFields form={form} onSubmit={() => void submit()} />
        {form.error !== null ? <InlineAlert tone="error">{form.error}</InlineAlert> : null}
        <Button disabled={form.pending} onClick={() => void submit()}>
          {form.pending ? 'Connecting…' : 'Connect'}
        </Button>
      </DrawerBody>
    </>
  )
}
