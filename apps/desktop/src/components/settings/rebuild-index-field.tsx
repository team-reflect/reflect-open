import { useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { rebuildIndexVisibly } from '@/lib/rebuild-index'
import { useGraph } from '@/providers/graph-provider'
import { SettingsField } from './field'

/**
 * The recovery lever for the local index: a one-click full rebuild from the
 * markdown files (the same action as the palette's "Rebuild search index").
 * Progress and failures surface through the operations status UI. The local
 * in-flight state only drives the label and disabled treatment —
 * rebuildIndexVisibly itself coalesces overlapping requests, including races
 * with the palette command.
 */
export function RebuildIndexField(): ReactElement {
  const { indexGeneration } = useGraph()
  const [rebuilding, setRebuilding] = useState(false)

  const rebuild = async (): Promise<void> => {
    if (indexGeneration === null || rebuilding) {
      return
    }
    setRebuilding(true)
    try {
      await rebuildIndexVisibly(indexGeneration)
    } finally {
      setRebuilding(false)
    }
  }

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
          disabled={indexGeneration === null || rebuilding}
          onClick={() => void rebuild()}
          className="text-text-secondary"
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild index'}
        </Button>
      </div>
    </SettingsField>
  )
}
