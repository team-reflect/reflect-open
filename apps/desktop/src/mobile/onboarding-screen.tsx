import { useState, type ReactElement } from 'react'
import { HardDrive } from 'lucide-react'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAsyncAction } from '@/hooks/use-async-action'
import { OnboardingIcloudSection } from '@/mobile/onboarding-icloud-section'
import { useGraph } from '@/providers/graph-provider'

/** Which control kicked off the in-flight choice, so only that one shows the
 * spinner/pending label (every button still disables). Container graph roots
 * are absolute paths, so the fixed tags can never collide with one. */
type PendingChoice = string | 'icloud-create' | 'local' | null

/**
 * The mobile first-run screen (Plans 19/21) — shown until the user picks
 * where their notes live, gated by the `mobileOnboarded` setting in
 * {@link GraphProvider}.
 *
 * iCloud Drive leads (Plan 21): it is the primary way a graph syncs between
 * iPhone and Mac, so the hero block ({@link OnboardingIcloudSection}) lists
 * every graph already in the app's iCloud container plus a create row.
 * **Keep notes on this device** opens the app-sandbox root instead (and is
 * promoted to the only storage card when iCloud is unavailable). Every
 * path ends in `completeOnboarding(kind, root)`, which opens the chosen root
 * and records the flag + storage kind + graph name.
 *
 * The screen renders before the iCloud container has resolved (the boot no
 * longer waits on it — see `useMobileGraphBoot`): while
 * `mobileStorageResolving` is set the iCloud card shows a pending row
 * instead of vanishing, since a null container root only means "signed out"
 * once the lookup finished.
 */
export function MobileOnboardingScreen(): ReactElement {
  const { mobileStorageInfo, mobileStorageResolving, completeOnboarding } = useGraph()
  const action = useAsyncAction()
  const [pendingChoice, setPendingChoice] = useState<PendingChoice>(null)

  const icloudDocumentsRoot = mobileStorageInfo?.icloudDocumentsRoot ?? null
  const icloudReady = icloudDocumentsRoot !== null
  // While the container is still resolving, the section renders in a pending
  // state instead of vanishing — "no iCloud" is only honest once known.
  const icloudPending = !icloudReady && mobileStorageResolving
  const icloudGraphs = mobileStorageInfo?.icloudGraphRoots ?? []

  function runChoice(choice: Exclude<PendingChoice, null>, task: () => Promise<void>): void {
    setPendingChoice(choice)
    void action.run(task).finally(() => setPendingChoice(null))
  }

  return (
    <div
      className="flex min-h-dvh w-screen overflow-auto bg-surface-app px-5 text-text"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 1.5rem)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)',
      }}
    >
      <div className="my-auto flex w-full flex-col gap-6">
        <div className="flex flex-col gap-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Welcome to Reflect</h1>
          <p className="text-sm text-text-muted">
            Your notes are plain markdown files. Choose where to keep them.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {icloudReady || icloudPending ? (
            <OnboardingIcloudSection
              pending={icloudPending}
              documentsRoot={icloudDocumentsRoot}
              graphs={icloudGraphs}
              busy={action.pending}
              pendingChoice={pendingChoice}
              onOpen={(root) => runChoice(root, () => completeOnboarding('icloud', root))}
              onCreate={(root) =>
                runChoice('icloud-create', () => completeOnboarding('icloud', root))
              }
            />
          ) : null}

          <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary">
                <HardDrive aria-hidden className="size-4" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="text-sm font-semibold">This device</h2>
                <p className="text-xs text-text-muted">Stored locally in Reflect on this device.</p>
              </div>
            </div>
            <Button
              variant={icloudReady || icloudPending ? 'outline' : 'default'}
              className="w-full"
              onClick={() => runChoice('local', () => completeOnboarding('local'))}
              disabled={action.pending || mobileStorageInfo === null}
            >
              {pendingChoice === 'local' ? (
                <Spinner />
              ) : (
                <HardDrive aria-hidden strokeWidth={1.75} />
              )}
              {pendingChoice === 'local' ? 'Setting up…' : 'Keep notes on this device'}
            </Button>
          </section>
          {!icloudReady && !icloudPending ? (
            <p className="text-center text-xs text-text-muted">
              Sign in to iCloud on this device to sync notes with iCloud Drive.
            </p>
          ) : null}
        </div>

        {action.error !== null ? <InlineAlert tone="error">{action.error}</InlineAlert> : null}
      </div>
    </div>
  )
}
