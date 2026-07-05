import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { FileArchive } from 'lucide-react'
import {
  importReflectV1Zip,
  markReflectV1ImportOwnWrites,
  type GraphImportSummary,
} from '@reflect/core'
import { SettingsField } from '@/components/settings/field'
import { SettingsSection } from '@/components/settings/section'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/hooks/use-async-action'
import { useGraph } from '@/providers/graph-provider'

function summaryText(summary: GraphImportSummary): string {
  const imported = `${summary.importedFiles} ${
    summary.importedFiles === 1 ? 'file' : 'files'
  } imported`
  if (summary.skippedFiles === 0) {
    return `${imported}.`
  }
  return `${imported}, ${summary.skippedFiles} already present.`
}

/**
 * Settings -> Import: copy a Reflect V1 export zip into the currently open
 * graph. V1 exports are graph-shaped now, which makes this a native unzip into
 * `daily/`, `notes/`, and `assets/` rather than a migration transform.
 */
export function ImportSection(): ReactElement {
  const { graph, refreshIndex } = useGraph()
  const action = useAsyncAction()
  const [summary, setSummary] = useState<GraphImportSummary | null>(null)
  const graphRef = useRef(graph)

  useLayoutEffect(() => {
    graphRef.current = graph
  }, [graph])

  async function chooseAndImport(): Promise<void> {
    setSummary(null)
    if (graph === null) {
      action.setError('Open or create a graph before importing a Reflect V1 export.')
      return
    }
    const currentGraph = graph
    await action.run(async () => {
      const result = await open({
        multiple: false,
        directory: false,
        title: 'Import Reflect V1 export',
        filters: [{ name: 'Zip archives', extensions: ['zip'] }],
      })
      const path = typeof result === 'string' ? result : null
      if (path === null) {
        return
      }
      const imported = await importReflectV1Zip(path, currentGraph.generation)
      const latestGraph = graphRef.current
      if (
        latestGraph === null ||
        latestGraph.root !== currentGraph.root ||
        latestGraph.generation !== currentGraph.generation
      ) {
        return
      }
      markReflectV1ImportOwnWrites(imported)
      setSummary(imported)
      refreshIndex()
    })
  }

  return (
    <SettingsSection id="import">
      <SettingsField
        legend="Reflect V1"
        description="Choose the .zip export from Reflect V1. Its markdown files are copied into this graph without replacing different existing files."
      >
        <div className="mt-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={action.pending || graph === null}
            onClick={() => void chooseAndImport()}
          >
            <FileArchive aria-hidden strokeWidth={1.75} />
            {action.pending ? 'Importing...' : 'Import zip...'}
          </Button>
        </div>
        {summary !== null ? (
          <p role="status" className="mt-2 text-xs text-text-muted">
            {summaryText(summary)}
          </p>
        ) : null}
        {action.error !== null ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {action.error}
          </p>
        ) : null}
      </SettingsField>
    </SettingsSection>
  )
}
