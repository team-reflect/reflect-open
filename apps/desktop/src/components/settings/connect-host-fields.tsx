import { useId, type ReactElement } from 'react'
import { Input } from '@/components/ui/input.tsx'
import type { ConnectHostForm } from '@/hooks/use-connect-host.ts'

interface ConnectHostFieldsProps {
  form: ConnectHostForm
  /** Submit on Enter in any field. */
  onSubmit: () => void
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * The three inputs of the "Another host" form, shared by desktop's dialog and
 * mobile's drawer: the repository's https:// URL, the username, and the
 * access token the host issued.
 */
export function ConnectHostFields({ form, onSubmit }: ConnectHostFieldsProps): ReactElement {
  const urlId = useId()
  const usernameId = useId()
  const tokenId = useId()

  function submitOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && !form.pending) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={urlId} className="flex flex-col gap-1">
        <span className={FIELD_LABEL_CLASS}>Repository URL</span>
        <Input
          id={urlId}
          autoFocus
          value={form.remoteUrl}
          placeholder="https://gitlab.com/you/notes.git"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => form.setRemoteUrl(event.target.value)}
          onKeyDown={submitOnEnter}
        />
      </label>
      <label htmlFor={usernameId} className="flex flex-col gap-1">
        <span className={FIELD_LABEL_CLASS}>Username</span>
        <Input
          id={usernameId}
          value={form.username}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => form.setUsername(event.target.value)}
          onKeyDown={submitOnEnter}
        />
      </label>
      <label htmlFor={tokenId} className="flex flex-col gap-1">
        <span className={FIELD_LABEL_CLASS}>Access token</span>
        <Input
          id={tokenId}
          type="password"
          value={form.token}
          onChange={(event) => form.setToken(event.target.value)}
          onKeyDown={submitOnEnter}
        />
      </label>
      <p className="text-xs text-text-muted">
        GitLab: a token with <code>write_repository</code>. Gitea, Forgejo and Codeberg: a token
        with <code>write:repository</code>. The token is checked against the host, then kept in your
        OS keychain and only ever sent to this host. SSH remotes are set up in a terminal.
      </p>
    </div>
  )
}
