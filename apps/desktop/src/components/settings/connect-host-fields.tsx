import { useId, type ReactElement } from 'react'
import { Input } from '@/components/ui/input.tsx'
import type { ConnectHostForm } from '@/hooks/use-connect-host.ts'

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

interface ConnectHostFieldsProps {
  form: ConnectHostForm
  /** Desktop focuses the URL on open; mobile leaves the keyboard down. */
  autoFocus?: boolean
}

/**
 * The three "Connect another host" inputs, shared by desktop's dialog and
 * mobile's drawer. The shells supply the `<form>` (Enter submits) and the
 * button.
 */
export function ConnectHostFields({
  form,
  autoFocus = false,
}: ConnectHostFieldsProps): ReactElement {
  const urlId = useId()
  const usernameId = useId()
  const tokenId = useId()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={urlId} className={FIELD_LABEL_CLASS}>
          Repository URL
        </label>
        <Input
          id={urlId}
          autoFocus={autoFocus}
          value={form.url}
          placeholder="https://gitlab.com/you/notes.git"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => form.setUrl(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={usernameId} className={FIELD_LABEL_CLASS}>
          Username
        </label>
        <Input
          id={usernameId}
          value={form.username}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          onChange={(event) => form.setUsername(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={tokenId} className={FIELD_LABEL_CLASS}>
          Token
        </label>
        <Input
          id={tokenId}
          type="password"
          value={form.token}
          autoComplete="off"
          enterKeyHint="go"
          onChange={(event) => form.setToken(event.target.value)}
        />
      </div>
      <p className="text-xs text-text-muted">
        A personal access token with write access to the repository. It stays in your keychain and
        is sent only to this host.
      </p>
    </div>
  )
}
