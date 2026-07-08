import { useState, type ReactElement } from 'react'
import { Cloud, HardDrive } from 'lucide-react'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAsyncAction } from '@/hooks/use-async-action'
import { OnboardingIcloudHeader } from '@/mobile/onboarding-icloud-header'
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
 * iCloud Drive leads (Plan 21): it is the primary way notes sync between
 * iPhone and Mac, so the hero block ({@link OnboardingIcloudSection}) either
 * continues with iCloud or lists existing note sets in the app's iCloud
 * container. **Keep notes on this device** opens the app-sandbox root instead.
 * Every path ends in `completeOnboarding(kind, root)`, which opens the chosen
 * root and records the flag + storage kind + graph name.
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
      <div className="mx-auto flex w-full max-w-md flex-col gap-7 py-6">
        <header className="flex flex-col gap-4 pt-2">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Cloud aria-hidden className="size-5" strokeWidth={1.75} />
          </div>
          <div className="space-y-2">
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight">
              Start with iCloud sync
            </h1>
            <p className="text-sm leading-6 text-text-secondary">
              Keep your notes up to date across iPhone, iPad, and Mac with iCloud Drive.
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-4">
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
          ) : (
            <IcloudUnavailableSection />
          )}

          <div className="flex flex-col items-center gap-1 px-4 text-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-text-secondary"
              onClick={() => runChoice('local', () => completeOnboarding('local'))}
              disabled={action.pending || mobileStorageInfo === null}
            >
              {pendingChoice === 'local' ? (
                <Spinner />
              ) : (
                <HardDrive aria-hidden strokeWidth={1.75} />
              )}
              {pendingChoice === 'local' ? 'Setting up…' : 'Or, use this device only'}
            </Button>
          </div>
        </div>

        {action.error !== null ? <InlineAlert tone="error">{action.error}</InlineAlert> : null}
      </div>
    </div>
  )
}

function IcloudUnavailableSection(): ReactElement {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <OnboardingIcloudHeader description="Turn on iCloud Drive to keep your notes synced between devices." />
      <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs leading-5 text-text-muted">
        Sign in to iCloud on this device, then reopen Reflect.
      </p>
    </section>
  )
}
