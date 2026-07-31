import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { errorMessage, hasBridge, mobileStorage, type MobileStorageKind } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import { Spinner } from '@/components/ui/spinner'
import { graphNameFromRoot } from '@/lib/graph-names'
import { NewGraphDrawer } from '@/mobile/new-graph-drawer'
import { MobileScreenHeader } from '@/mobile/screen-header'
import { SettingsActionRow, SettingsGroup, SettingsSelectRow } from '@/mobile/settings-list'
import { useGraph } from '@/providers/graph-provider'
import { useRouter } from '@/routing/router'

/**
 * The Graphs screen (route kind `graphs`) — the mobile graph switcher as an
 * iOS checkmark-selection list, pushed from Settings. iCloud Drive graphs
 * list first (they sync across devices), the on-device root below; tapping a
 * row switches to it, and a confirmed switch remounts the whole workspace
 * (the router is keyed by graph root), which pops this screen implicitly.
 * Creating a graph lives in its own sheet ({@link NewGraphDrawer}) rather
 * than an inline form. Storage roots are re-read on every mount — container
 * paths must never be cached across sessions, and another device may have
 * added a graph since the last look.
 */
export function MobileGraphs(): ReactElement {
  const { back, canBack, navigate } = useRouter()
  const { graph, completeOnboarding } = useGraph()
  const [pendingRoot, setPendingRoot] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const { data: storage } = useQuery({
    queryKey: ['mobile-storage'],
    queryFn: mobileStorage,
    enabled: hasBridge(),
    refetchOnMount: 'always',
  })

  const resolving = storage === undefined
  const icloudDocumentsRoot = storage?.icloudDocumentsRoot ?? null
  const icloudGraphRoots = storage?.icloudGraphRoots ?? []
  const localRoot = storage?.localRoot ?? null
  const busy = pendingRoot !== null

  function switchTo(kind: MobileStorageKind, root: string): Promise<void> {
    setPendingRoot(root)
    setSwitchError(null)
    return completeOnboarding(kind, root).then(
      () => {
        // A confirmed switch remounts the router (keyed by graph root), so
        // this screen is gone; clearing state only matters on failure paths.
        setPendingRoot(null)
      },
      (err: unknown) => {
        setPendingRoot(null)
        setSwitchError(errorMessage(err))
        throw err
      },
    )
  }

  function selectRow(kind: MobileStorageKind, root: string): void {
    if (busy || graph?.root === root) {
      return
    }
    switchTo(kind, root).catch(() => {
      // Surfaced via switchError; the rethrow is for the create sheet's own
      // error display.
    })
  }

  return (
    <div
      className="flex h-full w-screen flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <MobileScreenHeader
        title="Graphs"
        onBack={() => (canBack ? back() : navigate({ kind: 'settings' }))}
      />
      <main
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex flex-col gap-6 px-4 py-4">
          <SettingsGroup
            header="iCloud Drive"
            footer={
              resolving
                ? null
                : icloudDocumentsRoot === null
                  ? 'iCloud Drive isn’t available on this device.'
                  : 'Syncs with Reflect on your other devices.'
            }
          >
            {resolving ? (
              <div className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-[15px] text-text-muted">
                <Spinner />
                Looking for your notes…
              </div>
            ) : (
              <>
                {icloudGraphRoots.map((root) => (
                  <SettingsSelectRow
                    key={root}
                    label={graphNameFromRoot(root, root)}
                    selected={graph?.root === root}
                    pending={pendingRoot === root}
                    disabled={busy}
                    onPress={() => selectRow('icloud', root)}
                  />
                ))}
                {icloudDocumentsRoot !== null ? (
                  <SettingsActionRow
                    label="New graph"
                    icon={Plus}
                    disabled={busy}
                    onPress={() => setCreateOpen(true)}
                  />
                ) : null}
              </>
            )}
          </SettingsGroup>

          {localRoot !== null ? (
            <SettingsGroup footer="Notes stay on this device. Sync with GitHub from Settings.">
              <SettingsSelectRow
                label="This device"
                selected={graph?.root === localRoot}
                pending={pendingRoot === localRoot}
                disabled={busy}
                onPress={() => selectRow('local', localRoot)}
              />
            </SettingsGroup>
          ) : null}

          {switchError !== null ? <InlineAlert tone="error">{switchError}</InlineAlert> : null}
        </div>
      </main>
      {icloudDocumentsRoot !== null ? (
        <NewGraphDrawer
          open={createOpen}
          onOpenChange={setCreateOpen}
          documentsRoot={icloudDocumentsRoot}
          existingRoots={icloudGraphRoots}
          onCreate={(root) => switchTo('icloud', root)}
        />
      ) : null}
    </div>
  )
}
