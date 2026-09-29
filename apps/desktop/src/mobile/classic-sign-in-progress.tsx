import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, Dot } from 'lucide-react'
import appIcon from '@/assets/app-icon.png'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { queryKeys } from '@/lib/query-client.ts'
import type { ClassicSignIn } from '@/mobile/use-classic-access.ts'

type StepState = 'done' | 'active' | 'pending' | 'failed'

interface Step {
  state: StepState
  label: string
}

interface Screen {
  title: string
  steps: Step[]
}

function signedInLabel(email: string | null): string {
  return email === null ? 'Signed in to Reflect Classic' : `Signed in as ${email}`
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function screenFor(signIn: ClassicSignIn): Screen | null {
  const { mutation, checking } = signIn
  if (checking) {
    return {
      title: 'Unlocking Reflect',
      steps: [
        { state: 'done', label: 'Signed in to Reflect Classic' },
        { state: 'active', label: 'Checking your subscription…' },
        { state: 'pending', label: 'Working out your access' },
      ],
    }
  }
  if (mutation.isError) {
    return {
      title: "Couldn't unlock Reflect",
      steps: [
        {
          state: 'failed',
          label: "Couldn't check your subscription. Check your connection and try again.",
        },
      ],
    }
  }
  const result = mutation.data
  if (result?.kind === 'signed-in') {
    return {
      title: 'Reflect Pro is unlocked',
      steps: [
        { state: 'done', label: signedInLabel(result.access.email) },
        { state: 'done', label: 'Reflect Classic subscription found' },
        { state: 'done', label: `Free until ${formatDate(result.access.expiresAt)}` },
      ],
    }
  }
  if (result?.kind === 'not-eligible') {
    return {
      title: "Couldn't unlock Reflect",
      steps: [
        { state: 'done', label: signedInLabel(result.email) },
        { state: 'failed', label: 'No paid Reflect Classic subscription on this account' },
      ],
    }
  }
  return null
}

function StepIcon({ state }: { state: StepState }): ReactElement {
  switch (state) {
    case 'done':
      return <Check className="size-4" strokeWidth={3} />
    case 'active':
      return <Spinner className="size-4" />
    case 'pending':
      return <Dot className="size-4 text-text-muted" />
    case 'failed':
      return <CircleAlert className="size-4 text-destructive" />
  }
}

/**
 * Full-screen progress of a Reflect Classic sign-in, from the moment the
 * sign-in sheet closes until the user acknowledges the result. Renders nothing
 * while idle, while the sheet is open, or after a cancelled sheet.
 */
export function ClassicSignInProgress({
  signIn,
  doneLabel,
}: {
  signIn: ClassicSignIn
  doneLabel: string
}): ReactElement | null {
  const queryClient = useQueryClient()
  const screen = screenFor(signIn)
  if (screen === null) return null
  const { mutation } = signIn

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.classic.access })
    mutation.reset()
  }

  return (
    <div
      role="dialog"
      aria-modal
      aria-labelledby="classic-sign-in-title"
      className="fixed inset-0 z-40 flex bg-surface-app px-5 text-text"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 1.5rem)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)',
      }}
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-6">
        <div className="mt-[20vh] flex flex-col gap-5">
          <img src={appIcon} alt="" draggable={false} className="size-11 rounded-xl" />
          <h1 id="classic-sign-in-title" className="text-[24px] font-semibold leading-tight">
            {screen.title}
          </h1>
          <ul className="flex flex-col gap-3" aria-live="polite">
            {screen.steps.map((step) => (
              <li
                key={step.label}
                className="flex items-start gap-3 text-sm leading-5"
                data-state={step.state}
              >
                <span aria-hidden className="flex h-5 shrink-0 items-center">
                  <StepIcon state={step.state} />
                </span>
                <span className={step.state === 'pending' ? 'text-text-muted' : undefined}>
                  {step.label}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto flex flex-col items-center gap-4">
          {mutation.data?.kind === 'signed-in' ? (
            <Button className="h-12 w-full rounded-xl text-base" onClick={() => void done()}>
              {doneLabel}
            </Button>
          ) : null}
          {mutation.data?.kind === 'not-eligible' ? (
            <Button
              className="h-12 w-full rounded-xl text-base"
              onClick={() => mutation.mutate(true)}
            >
              Use a different account
            </Button>
          ) : null}
          {mutation.isError ? (
            <Button
              className="h-12 w-full rounded-xl text-base"
              onClick={() => mutation.mutate(false)}
            >
              Try again
            </Button>
          ) : null}
          {mutation.data?.kind === 'not-eligible' || mutation.isError ? (
            <button
              type="button"
              className="text-sm text-text-secondary underline"
              onClick={() => mutation.reset()}
            >
              Back
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
