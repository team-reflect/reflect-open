import { useEffect, type ReactElement } from 'react'
import { GraphChooser } from '@/components/graph-chooser.tsx'
import { GraphWorkspace } from '@/components/graph-workspace.tsx'
import { installQuitFlush } from '@/lib/quit-flush.ts'
import { isMainWindow } from '@/lib/windows/window-role.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Root component — the Plan 02 loading gate. Routes between the graph chooser
 * and the workspace based on whether a graph is open. Real product surfaces
 * (daily notes, search, AI) hang off the workspace in later plans.
 */
export function App(): ReactElement {
  const { status, graph, error } = useGraph()

  // Quit-time persistence: flush dirty note buffers when exiting, awaiting
  // persistence before destruction but hiding the macOS main window first.
  // Unmount effects don't run on those paths. installQuitFlush returns its
  // teardown, which the effect returns as cleanup.
  useEffect(() => {
    return installQuitFlush()
  }, [])

  if (status === 'ready' && graph) {
    return <GraphWorkspace graph={graph} />
  }

  if (status === 'choosing') {
    // A secondary note window never chooses: opening a graph from here would
    // re-root every other window. Landing in this state means its bootstrap
    // failed (e.g. it raced a graph switch) — say so and stop.
    if (!isMainWindow()) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-1 px-8 text-center text-sm text-text-muted">
          <p>This window couldn’t open the graph. Close it and reopen from the main window.</p>
          {error !== null ? <p className="text-xs">{error}</p> : null}
        </div>
      )
    }
    return <GraphChooser />
  }

  // 'loading' | 'opening'
  return (
    <div className="flex h-screen w-screen items-center justify-center text-sm text-text-muted">
      Loading…
    </div>
  )
}
