import { join } from '@tauri-apps/api/path'
import { errorMessage } from '@reflect/core'
import { startOperation } from '@/lib/operations'

/**
 * "Copy note path" as keyboard surfaces run it (⌥⌘C and the ⌘K command):
 * resolve the graph-relative `path` to an absolute filesystem path for use in
 * tools outside Reflect (agent chats, editors, terminals), put it on the
 * clipboard, and report through the operations status line. Joining through
 * Tauri preserves the host platform's path syntax.
 */
export async function runCopyNotePath(root: string | null, path: string): Promise<void> {
  if (root === null) {
    startOperation('Copying note path').fail('No graph is open')
    return
  }
  try {
    const absolutePath = await join(root, path)
    await navigator.clipboard.writeText(absolutePath)
    startOperation('Note path copied').done()
  } catch (cause) {
    startOperation('Copying note path').fail(errorMessage(cause))
  }
}
