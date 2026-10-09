import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { ConnectHostFields } from '@/components/settings/connect-host-fields.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'
import { useConnectHost } from '@/hooks/use-connect-host.ts'

interface ConnectHostDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The mobile "Connect another host" bottom sheet: a Drawer shell over
 * {@link useConnectHost} (the same form as desktop's dialog). Offered only
 * for the local ("This device") graph, like the GitHub sheet. The body
 * mounts per open cycle, so a dismissed half-filled form never leaks into
 * the next open.
 */
export function ConnectHostDrawer({ open, onOpenChange }: ConnectHostDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Connect another host">
        {open ? <ConnectHostSheet onClose={() => onOpenChange(false)} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

function ConnectHostSheet({ onClose }: { onClose: () => void }): ReactElement {
  const form = useConnectHost(onClose)
  return (
    <>
      <DrawerTitle>Connect another host</DrawerTitle>
      <DrawerBody>
        <p className="text-xs text-text-muted">
          Back up this graph to a repository on GitLab, Gitea, Codeberg, or your own server, over
          HTTPS with a token.
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void form.submit()
          }}
        >
          <ConnectHostFields form={form} />
          <Button type="submit" disabled={form.pending}>
            {form.pending ? 'Connecting…' : 'Connect'}
          </Button>
        </form>
        {form.error !== null ? <InlineAlert tone="error">{form.error}</InlineAlert> : null}
      </DrawerBody>
    </>
  )
}
