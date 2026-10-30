import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { SettingsSection } from './section.tsx'

/**
 * Settings → Graph on the iPad: the open graph and where it lives. The iOS
 * app keeps its graphs in fixed roots (the iCloud Drive container or the app
 * sandbox), so instead of desktop's folder picker the switch opens the iOS
 * graph list, which also creates iCloud graphs. iOS only: the settings screen
 * mounts this section only there (see use-visible-settings-sections).
 */
export function GraphSection(): ReactElement {
  const { graph, mobileStorageKind } = useGraph()
  const { navigate } = useRouter()
  const storage =
    mobileStorageKind === 'icloud'
      ? 'iCloud Drive'
      : mobileStorageKind === 'local'
        ? 'This device'
        : null
  return (
    <SettingsSection id="graph">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text">{graph?.name ?? '—'}</div>
          {storage !== null ? <p className="mt-0.5 text-xs text-text-muted">{storage}</p> : null}
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate({ kind: 'graphs' })}>
          Switch graph…
        </Button>
      </div>
    </SettingsSection>
  )
}
