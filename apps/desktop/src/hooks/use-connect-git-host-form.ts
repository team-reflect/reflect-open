import { useForm, type UseFormReturn } from 'react-hook-form'
import { errorMessage, redactRemoteUrl, type ConnectGitHostInput } from '@reflect/core'
import { useGitSync } from '@/providers/sync-provider.tsx'

export interface ConnectGitHostForm {
  /** The form, for a `FormProvider` around {@link ConnectGitHostFields}. */
  form: UseFormReturn<ConnectGitHostInput>
  /** The form's submit handler: probe the host, store the sign-in, connect. */
  submit: (event?: React.BaseSyntheticEvent) => Promise<void>
}

/**
 * The "Other host" form, shared by the desktop dialog and the mobile sheet:
 * `react-hook-form` owns the fields, the pending state (`isSubmitting`) and
 * the host's refusal (the `root` error), so each shell only renders. The
 * graph's host connector checks the sign-in with the host before it stores
 * anything, so a refusal lands inline with the fields intact.
 */
export function useConnectGitHostForm({
  remoteUrl,
  onDone,
}: {
  /**
   * The remote that is already set and needs a new sign-in. With it the form
   * updates the sign-in only; without it the form connects a repository.
   */
  remoteUrl: string | undefined
  /** Called once the host accepted the sign-in and the graph is connected. */
  onDone: () => void
}): ConnectGitHostForm {
  const { connectGitHost, updateGitHostSignIn } = useGitSync()
  // A remote that is already set keeps its address and branch: only the
  // sign-in changes, and the connector probes the configured remote itself.
  const send =
    remoteUrl === undefined
      ? connectGitHost
      : ({ username, token }: ConnectGitHostInput) => updateGitHostSignIn({ username, token })
  const form = useForm<ConnectGitHostInput>({
    mode: 'onBlur',
    // A remote set by hand may carry a sign-in in its URL; the form never
    // shows one, and the connector refuses one.
    defaultValues: {
      remoteUrl: remoteUrl === undefined ? '' : redactRemoteUrl(remoteUrl),
      username: '',
      token: '',
    },
  })
  const submit = form.handleSubmit(async (values) => {
    form.clearErrors('root')
    try {
      await send(values)
      onDone()
    } catch (error: unknown) {
      form.setError('root', { message: errorMessage(error) })
    }
  })
  return { form, submit }
}
