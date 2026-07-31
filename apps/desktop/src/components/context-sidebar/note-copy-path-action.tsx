import type { ReactElement } from 'react'
import { join } from '@tauri-apps/api/path'
import { errorMessage } from '@reflect/core'
import { Copy } from 'lucide-react'
import { startOperation } from '@/lib/operations'
import { useGraph } from '@/providers/graph-provider'

interface NoteCopyPathActionProps {
  /** Graph-relative path of the note whose absolute path should be copied. */
  path: string
}

/**
 * Copies the note's absolute filesystem path for pasting into agent chats and
 * other tools outside Reflect. Joining through Tauri preserves the host
 * platform's path syntax.
 */
export function NoteCopyPathAction({ path }: NoteCopyPathActionProps): ReactElement {
  const { graph } = useGraph()

  const copyPath = async (): Promise<void> => {
    if (graph === null) {
      startOperation('Copying note path').fail('No graph is open')
      return
    }
    try {
      const absolutePath = await join(graph.root, path)
      await navigator.clipboard.writeText(absolutePath)
      startOperation('Note path copied').done()
    } catch (cause) {
      startOperation('Copying note path').fail(errorMessage(cause))
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copyPath()}
      className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start transition-colors duration-100 hover:bg-surface-hover"
    >
      <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted transition-colors duration-100 group-hover:text-text">
        <Copy size={14} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">Copy note path</span>
    </button>
  )
}
