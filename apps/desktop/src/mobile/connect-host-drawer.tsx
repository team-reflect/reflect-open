import { useId, useState, type ReactElement } from 'react'
import { errorMessage, remoteCredentialOrigin } from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { useSyncContext } from '@/providers/sync-provider.tsx'

interface ConnectHostDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The mobile "Connect another host" bottom sheet: back this graph up to a
 * non-GitHub git host (GitLab, a GitHub Enterprise instance, …) with a
 * username and access token.
 *
 * Why a token rather than SSH, which desktop uses for these hosts: iOS has no
 * ssh-agent, so the agent transport has no phone story. A token over HTTPS is
 * the transport that works here, and it lives in the iOS keychain.
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

/** The sheet body — separate so each open starts from empty fields. */
function ConnectHostSheet({ onClose }: { onClose: () => void }): ReactElement {
  const sync = useSyncContext()
  const urlId = useId()
  const usernameId = useId()
  const tokenId = useId()
  const [remoteUrl, setRemoteUrl] = useState('')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedUrl = remoteUrl.trim()
  // The same parse the credential store uses, so a URL that would key the
  // keychain differently can never be accepted here.
  const origin = trimmedUrl === '' ? null : remoteCredentialOrigin(trimmedUrl)
  const urlInvalid = trimmedUrl !== '' && origin === null
  const canConnect =
    origin !== null && username.trim() !== '' && token.trim() !== '' && !busy && sync !== null

  function connect(): void {
    if (!canConnect || sync === null) {
      return
    }
    setBusy(true)
    setError(null)
    sync
      .connectHostRemote(trimmedUrl, { username: username.trim(), secret: token.trim() })
      .then(onClose)
      .catch((err: unknown) => {
        setBusy(false)
        setError(errorMessage(err))
      })
  }

  function submitOnEnter(event: { key: string }): void {
    if (getIsComposing()) {
      return
    }
    if (event.key === 'Enter') {
      connect()
    }
  }

  return (
    <>
      <DrawerTitle>Connect another host</DrawerTitle>
      <DrawerBody>
        <p className="text-xs text-text-secondary">
          Back this graph up to a non-GitHub git repository with an access token.
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={urlId} className={FIELD_LABEL_CLASS}>
            Repository URL
          </label>
          <Input
            id={urlId}
            value={remoteUrl}
            placeholder="https://git.example.com/you/notes.git"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            onChange={(event) => setRemoteUrl(event.target.value)}
            aria-invalid={urlInvalid}
            disabled={busy}
          />
          {urlInvalid ? (
            <p className="text-xs text-destructive">
              Enter the repository’s https:// URL. SSH remotes aren’t supported on iPhone — there’s
              no ssh-agent to hold the key.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={usernameId} className={FIELD_LABEL_CLASS}>
            Username
          </label>
          <Input
            id={usernameId}
            value={username}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={tokenId} className={FIELD_LABEL_CLASS}>
            Access token
          </label>
          <Input
            id={tokenId}
            value={token}
            type="password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={submitOnEnter}
            disabled={busy}
          />
          <p className="text-xs text-text-secondary">
            Stored in the iPhone’s keychain, and only ever sent to {origin ?? 'this host'}.
          </p>
        </div>
        {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button type="button" disabled={!canConnect} onClick={connect}>
          {busy ? <Spinner /> : null}
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </DrawerBody>
    </>
  )
}
