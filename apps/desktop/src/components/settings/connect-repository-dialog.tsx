import type { ReactElement } from 'react'
import { useForm } from 'react-hook-form'
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
import { useGithubConnected } from '@/hooks/use-github-connected.ts'

/** Where a repository can be: GitHub, through the account, or any other Git host, by address. */
export type RepositoryHost = 'github' | 'other'

interface ConnectRepositoryDialogProps {
  /** The host the user chose; the caller opens that host's own flow. */
  onChoose: (host: RepositoryHost) => void
  onClose: () => void
}

/**
 * The one door to a repository: a two-way choice, then the flow of the chosen
 * host. GitHub gets the connect wizard; any other host gets the address form.
 */
export function ConnectRepositoryDialog({
  onChoose,
  onClose,
}: ConnectRepositoryDialogProps): ReactElement {
  const githubConnected = useGithubConnected()
  const { register, handleSubmit } = useForm<{ host: RepositoryHost }>({
    defaultValues: { host: 'github' },
  })
  const submit = handleSubmit((values) => {
    onChoose(values.host)
  })
  const options: { value: RepositoryHost; label: string; detail: string }[] = [
    {
      value: 'github',
      label: 'GitHub',
      detail: githubConnected
        ? 'Create a repository or pick one of yours.'
        : 'Sign in, then create a repository or pick one of yours.',
    },
    {
      value: 'other',
      label: 'Other host',
      detail: 'Any HTTPS Git repository.',
    },
  ]

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>Where is the repository?</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void submit(event)
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Where is the repository?</legend>
            {options.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-surface-hover has-checked:border-accent has-checked:ring-1 has-checked:ring-accent"
              >
                <input
                  type="radio"
                  value={option.value}
                  {...register('host')}
                  className="mt-1 accent-accent"
                />
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-text">{option.label}</span>
                  <span className="text-xs text-text-muted">{option.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="ghost" size="sm">
                  Cancel
                </Button>
              }
            />
            <Button type="submit" size="sm">
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
