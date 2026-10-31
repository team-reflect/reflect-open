import type { ReactElement } from 'react'
import { FileArchive } from 'lucide-react'
import { SettingsField } from '@/components/settings/field.tsx'
import { SettingsSection } from '@/components/settings/section.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useV1Import } from '@/providers/v1-import-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Settings -> Import: pick a Reflect V1 export zip and hand it to the
 * workspace's {@link useV1Import} controller, which runs the import and shows
 * its progress in a modal dialog — the import outlives this section, so
 * navigating away from settings doesn't interrupt it.
 */
export function ImportSection(): ReactElement {
  const { state, startImport } = useV1Import()
  const { dialog } = useAppServices()
  const running = state.phase === 'running'

  async function chooseAndImport(): Promise<void> {
    const picked = await dialog.pickFiles({
      multiple: false,
      title: 'Import Reflect V1 export',
      filters: [{ name: 'Zip archives', extensions: ['zip'] }],
    })
    const path = picked?.[0]
    if (path === undefined) {
      return
    }
    startImport(path)
  }

  return (
    <SettingsSection id="import">
      <SettingsField
        legend="Reflect V1"
        description="Choose the .zip export from Reflect V1. Its notes and attachments are added to this graph; nothing already here is replaced."
      >
        <div className="mt-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={running}
            onClick={() => void chooseAndImport()}
          >
            <FileArchive aria-hidden strokeWidth={1.75} />
            {running ? 'Importing...' : 'Import zip...'}
          </Button>
        </div>
      </SettingsField>
    </SettingsSection>
  )
}
