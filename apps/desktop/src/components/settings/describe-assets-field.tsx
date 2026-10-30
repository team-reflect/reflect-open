import { useCallback, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { SettingsField } from './field.tsx'

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
  const { assetDescription } = useCoreServices()
  const [confirming, setConfirming] = useState(false)
  const backfill = useAsyncAction()

  const hasProvider = settings.aiProviders.length > 0

  const { run: runAction } = backfill
  const runBackfill = useCallback((): void => {
    setConfirming(false)
    // `error` is intentionally not rendered: the operations UI owns failures.
    void runAction(async () => {
      await assetDescription.backfillVisibly()
    })
  }, [runAction, assetDescription])

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
          disabled={graph === null || !hasProvider || backfill.pending}
          onClick={() => setConfirming(true)}
          className="text-text-secondary"
        >
          {backfill.pending ? 'Scanning…' : 'Scan existing files'}
        </Button>
        {!hasProvider ? (
          <p className="mt-2 text-xs text-text-muted">Add an AI provider to enable this.</p>
        ) : null}
      </div>
      {confirming ? (
        <Dialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) setConfirming(false)
          }}
        >
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Scan existing files?</DialogTitle>
              <DialogDescription>
                Images and PDFs in non-private notes will be sent to your AI provider so their text
                can appear in search. Assets that already have OCR are skipped.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={runBackfill}>
                Scan existing files
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </SettingsField>
  )
}
