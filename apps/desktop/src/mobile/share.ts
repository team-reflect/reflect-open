import { invoke } from '@tauri-apps/api/core'
import { readNote, splitFrontmatter } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/**
 * Share a note through the OS share sheet (Plan 19, V1 parity) — the
 * `tauri-plugin-sharesheet` native command. Shares the markdown **body**
 * (frontmatter stripped, so the recipient never sees the `id:` block), with
 * the title (the readable filename) as the subject for targets that use one
 * (Mail).
 *
 * Prefers the **live editor buffer** (`openSession`) over disk: the note is
 * open on the screen the Share action lives on, and its session is debounced
 * — `readNote` alone would share the last *saved* bytes and drop the user's
 * most recent typing. Falls back to disk when no session is open (the same
 * read-live-first contract as pin).
 */
export async function shareNote(path: string): Promise<void> {
  const source = openSession(path)?.content() ?? (await readNote(path))
  const text = splitFrontmatter(source).body.trimStart()
  await invoke('plugin:sharesheet|share', { payload: { text, title: noteTitle(path) } })
}

/** The basename without its `.md` — the note's working title (Plan 17). */
function noteTitle(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}
