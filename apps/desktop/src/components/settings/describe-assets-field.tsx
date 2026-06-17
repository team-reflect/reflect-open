import { useState, type ReactElement } from 'react'
import type { AiProvidersState } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { backfillAssetDescriptionsVisibly } from '@/lib/asset-backfill'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import { SettingsField } from './field'

/**
 * Settings → Search → OCR assets (Plan 20): a toggle for the automatic path
 * (read new images/PDFs as they're added) plus an explicit backfill, gated
 * behind a cost-warning confirmation because
 * an existing graph can hold many large or costly assets. Progress and final
 * state surface through the operations status UI.
 */
export function DescribeAssetsField(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const { graph } = useGraph()
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)

  const hasProvider = settings.aiProviders.length > 0
  const generation = graph?.generation ?? null

  const runBackfill = async (): Promise<void> => {
    setConfirming(false)
    if (generation === null || running) {
      return
    }
    const providers: AiProvidersState = {
      providers: settings.aiProviders,
      defaultProviderId: settings.defaultAiProviderId,
    }
    setRunning(true)
    try {
      await backfillAssetDescriptionsVisibly(generation, providers)
    } finally {
      setRunning(false)
    }
  }

  return (
    <SettingsField
      legend="OCR assets"
      description="Make text in images and PDFs searchable. Private notes are skipped."
    >
      <div className="mt-3 flex items-center gap-3">
        <Switch
          aria-label="OCR new assets automatically"
          checked={settings.describeAssets}
          onCheckedChange={(checked) => updateSettings({ describeAssets: checked })}
        />
        <span className="text-xs text-text-muted">OCR new assets automatically</span>
      </div>
      <div className="mt-3 flex flex-col items-start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={generation === null || !hasProvider || running}
          onClick={() => setConfirming(true)}
          className="text-text-secondary"
        >
          {running ? 'Backfilling…' : 'Backfill assets'}
        </Button>
        {!hasProvider ? (
          <p className="mt-2 text-xs text-text-muted">Add an AI provider to enable this.</p>
        ) : null}
      </div>
      {confirming ? (
        <Dialog open onOpenChange={(isOpen) => { if (!isOpen) setConfirming(false) }}>
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Backfill assets?</DialogTitle>
              <DialogDescription>
                Images and PDFs in non-private notes will be sent to your AI provider so their
                text can appear in search. Assets that already have OCR are skipped.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void runBackfill()}>
                Backfill assets
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </SettingsField>
  )
}
