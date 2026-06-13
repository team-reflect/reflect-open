import { splitFrontmatter } from '@reflect/core'
import { openSession } from '@/editor/open-documents'
import { readNoteOrEmpty } from '@/lib/note-read'

/**
 * Share a note through the OS share sheet (Plan 19, V1 parity) via the Web
 * Share API. The Tauri iOS WKWebView exposes a working `navigator.share`
 * (verified on-device), so no native plugin is needed — WebKit presents the
 * same `UIActivityViewController`.
 *
 * Shares the markdown **body** (frontmatter stripped, so the recipient never
 * sees the `id:` block), with the title (the readable filename) as the
 * subject for targets that use one (Mail).
 *
 * Prefers the **live editor buffer** over disk: the note is open on the
 * screen this action lives on, and its session is debounced — disk alone
 * would drop the user's most recent typing. `liveContent()` returns the
 * buffer only once the session is *ready*, so a genuinely-empty loaded note
 * stays authoritative (shares empty), while a session still loading returns
 * `null` and we read disk instead of sharing the loading buffer's transient
 * emptiness. Reading the ready buffer is synchronous, which also keeps the
 * tap's transient activation alive for `navigator.share` (an `await` first
 * would consume it).
 *
 * The disk fallback uses `readNoteOrEmpty`: a lazy note (`createIfMissing`)
 * has no file until its first save, so a plain read would throw during the
 * loading window — sharing empty is the right answer for a not-yet-written
 * note.
 */
export async function shareNote(path: string): Promise<void> {
  const source = openSession(path)?.liveContent() ?? (await readNoteOrEmpty(path))
  const text = splitFrontmatter(source).body.trimStart()
  await navigator.share({ title: noteTitle(path), text })
}

/** The basename without its `.md` — the note's working title (Plan 17). */
function noteTitle(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}
