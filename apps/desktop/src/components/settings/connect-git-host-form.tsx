import { useId, type ReactElement, type ReactNode } from 'react'
import { useFormContext, useFormState } from 'react-hook-form'
import { classifyRemote, type ConnectGitHostInput } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Input } from '@/components/ui/input.tsx'

interface ConnectGitHostFieldsProps {
  /** The form's submit handler ({@link useConnectGitHostForm}). */
  onSubmit: (event?: React.BaseSyntheticEvent) => Promise<void>
  /**
   * True when the form updates the sign-in of the remote already set: the
   * address is shown but not editable, since the connector signs in to the
   * configured remote.
   */
  updating: boolean
  /**
   * The submit controls, rendered inside the form so Enter in any field
   * submits. `canSubmit` is false while pending or while the address is one
   * the form cannot take.
   */
  actions: (state: { pending: boolean; canSubmit: boolean }) => ReactNode
}

const FIELD_LABEL_CLASS = 'text-xs font-medium text-text-secondary'

/**
 * What the address field says about an address the form cannot take. `true`
 * passes. The connector checks again on submit; this is the early word.
 */
function checkAddress(value: string): true | string {
  const url = value.trim()
  if (url === '') {
    return 'Enter the repository’s https address.'
  }
  const remote = classifyRemote(url)
  switch (remote.kind) {
    case 'github':
      return 'This is a GitHub repository: go back and choose GitHub.'
    case 'ssh':
      return 'This is an SSH address; the form takes https. Add it with git and Reflect picks it up.'
    case 'path':
      return 'Enter the repository’s https address.'
    case 'https':
      return remote.origin.startsWith('http:')
        ? 'Reflect does not send sign-ins over plain http. Use the https address.'
        : true
  }
}

/**
 * The "Other host" fields, shared by desktop's dialog and mobile's drawer,
 * inside the `FormProvider` of {@link useConnectGitHostForm}: the
 * repository's https address, the username, and the access token or
 * password the host takes. No help text: each mistake gets its own message
 * when it happens.
 */
export function ConnectGitHostFields({
  onSubmit,
  updating,
  actions,
}: ConnectGitHostFieldsProps): ReactElement {
  const { register } = useFormContext<ConnectGitHostInput>()
  const addressErrorId = useId()
  // Nested in a `FormProvider`, the form state is subscribed through this hook.
  const { isSubmitting: pending, errors } = useFormState<ConnectGitHostInput>()
  const addressError = errors.remoteUrl?.message
  const refusal = errors.root?.message

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        void onSubmit(event)
      }}
    >
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Repository address</span>
          <Input
            {...register('remoteUrl', updating ? {} : { validate: checkAddress })}
            readOnly={updating}
            aria-invalid={addressError !== undefined || undefined}
            aria-describedby={addressError !== undefined ? addressErrorId : undefined}
            autoFocus={!updating}
            placeholder="https://git.example.com/user/repo.git"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {addressError !== undefined ? (
            <span
              id={addressErrorId}
              role="alert"
              className="text-xs text-red-700 dark:text-red-300"
            >
              {addressError}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Username</span>
          <Input
            {...register('username')}
            autoFocus={updating}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Access token or password</span>
          <Input {...register('token')} type="password" autoComplete="current-password" />
        </label>
      </fieldset>
      {refusal !== undefined ? <InlineAlert tone="error">{refusal}</InlineAlert> : null}
      {actions({ pending, canSubmit: !pending && addressError === undefined })}
    </form>
  )
}
