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
  if (noteEditorHandleFor(notePath) === null) {
    return
  }
  const picked = await open({ multiple: true, title: 'Attach files' })
  if (picked === null) {
    return
  }
  const sources = Array.isArray(picked) ? picked : [picked]
  const links: string[] = []
  const attachedNames: string[] = []
  const failures: { name: string; cause: unknown }[] = []
  for (const source of sources) {
    // Each copy is independent — one failure must not drop the files picked
    // after it.
    const name = basenameOf(source)
    try {
      const assetPath = await importAsset(source, assetFileName(name), generation)
      links.push(`[${escapeLinkLabel(name)}](${assetPath})`)
      attachedNames.push(name)
    } catch (cause) {
      failures.push({ name, cause })
    }
  }
  const problems: string[] = []
  if (links.length > 0) {
    // Re-resolved after the awaits: the picker (and the copies) can outlive
    // the editor that was mounted when the command fired — a navigation in
    // between would otherwise send the insertion into a dead handle and the
    // copied files would sit in assets/ with no links and no explanation.
    const handle = noteEditorHandleFor(notePath)
    if (handle === null) {
      problems.push(
        `the note closed before its links could be inserted — ` +
          `${attachedNames.join(', ')} were still copied into assets/`,
      )
    } else {
      handle.insertMarkdown(links.join('\n'))
      handle.focus()
    }
  }
  if (failures.length > 0) {
    const details = failures
      .map(({ name, cause }) => `${name} (${errorMessage(cause)})`)
      .join(', ')
    problems.push(`could not be copied: ${details}`)
  }
  if (problems.length > 0) {
    // Command dispatch has no error channel of its own — surface everything
    // that went wrong as one failed operation, like other background work.
    startOperation('Attaching file').fail(problems.join('; '))
  }
}
