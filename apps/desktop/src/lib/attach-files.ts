import { open } from '@tauri-apps/plugin-dialog'
import { assetFileName, errorMessage, importAsset } from '@reflect/core'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry'
import type { CommandContext } from '@/lib/commands/types'
import { startOperation } from '@/lib/operations'

function basenameOf(sourcePath: string): string {
  const segments = sourcePath.split(/[/\\]/)
  return segments[segments.length - 1] ?? sourcePath
}

/** Escape `\`, `[`, and `]` so a filename stays inside its `[text]` label. */
function escapeLinkLabel(name: string): string {
  return name.replaceAll(/[\\[\]]/g, String.raw`\$&`)
}

/**
 * The Attach file… command: native file picker → each pick copied
 * file-to-file into the graph's `assets/` (the bytes never enter the
 * webview) → one `[original name](assets/…)` link per file inserted at the
 * caret of the current note's editor — the same markdown a drag-and-drop
 * produces, so the two entry points can't drift.
 *
 * No-ops without an open graph, a routed note, or a mounted editor; a
 * cancelled picker inserts nothing. When one copy fails mid-batch, the links
 * for the files that already landed are still inserted — they exist in
 * `assets/` either way, and an unlinked copy would be an invisible orphan.
 */
export async function attachFilesToNote(context: CommandContext): Promise<void> {
  const generation = context.generation()
  const notePath = context.notePath()
  if (generation === null || notePath === null) {
    return
  }
  const handle = noteEditorHandleFor(notePath)
  if (handle === null) {
    return
  }
  const picked = await open({ multiple: true, title: 'Attach files' })
  if (picked === null) {
    return
  }
  const sources = Array.isArray(picked) ? picked : [picked]
  const links: string[] = []
  let failure: unknown = null
  for (const source of sources) {
    const name = basenameOf(source)
    try {
      const assetPath = await importAsset(source, assetFileName(name), generation)
      links.push(`[${escapeLinkLabel(name)}](${assetPath})`)
    } catch (cause) {
      failure = cause
      break
    }
  }
  if (links.length > 0) {
    handle.insertMarkdown(links.join('\n'))
    handle.focus()
  }
  if (failure !== null) {
    // Command dispatch has no error channel of its own — surface the failure
    // like other background work.
    startOperation('Attaching file').fail(errorMessage(failure))
  }
}
