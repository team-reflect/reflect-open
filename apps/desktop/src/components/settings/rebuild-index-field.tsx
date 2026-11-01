import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { SettingsField } from './field.tsx'

/**
 * The recovery lever for the local index: a one-click full rebuild from the
 * markdown files (the same action as the palette's "Rebuild search index").
 * Progress and failures surface through the operations status UI. The local
 * in-flight state only drives the label and disabled treatment —
 * `rebuildVisibly` itself coalesces overlapping requests, including races
 * with the palette command.
 */
export function RebuildIndexField(): ReactElement {
  const { indexGeneration } = useGraph()
  const { indexLifecycle } = useCoreServices()
  const rebuild = useAsyncAction()

  return (
    <SettingsField
      legend="Rebuild index"
      description="Reflect keeps a local index of your notes to power search and links. If results ever look stale or incomplete, rebuild it — your notes are never changed."
    >
      <div className="mt-3 flex justify-start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={indexGeneration === null || rebuild.pending}
          onClick={() => void rebuild.run(() => indexLifecycle.rebuildVisibly())}
          className="text-text-secondary"
        >
          {rebuild.pending ? 'Rebuilding…' : 'Rebuild index'}
        </Button>
      </div>
      {rebuild.error !== null ? (
        <InlineAlert tone="error" className="mt-2">
          {rebuild.error}
        </InlineAlert>
      ) : null}
    </SettingsField>
  )
}
