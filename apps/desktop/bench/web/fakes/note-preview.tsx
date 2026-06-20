import { useEffect, useState, type ReactElement } from 'react'
import type { NoteEntry } from '@/components/command-palette/entries'

/**
 * Stand-in preview with real mount/effect lifecycle so a remount (path key) has
 * measurable teardown/setup cost vs an in-place update (stable key).
 * Browser-harness only.
 */
export function NotePreview({ entry }: { entry: NoteEntry }): ReactElement {
  const [mountedAt] = useState(() => performance.now())
  useEffect(() => {
    const node = document.createElement('div')
    return () => {
      void node
    }
  }, [])
  return (
    <div data-testid="bench-preview" data-mounted-at={mountedAt}>
      <div className="text-sm">{entry.title}</div>
      <div className="text-xs">{entry.path}</div>
    </div>
  )
}
