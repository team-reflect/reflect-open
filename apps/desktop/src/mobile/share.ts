import { readNote, splitFrontmatter } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

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
 * Prefers the **live editor buffer** (`openSession().content()`) over disk:
 * the note is open on the screen this action lives on, and its session is
 * debounced — disk alone would drop the user's most recent typing. Reading it
 * is also synchronous, which keeps the tap's transient activation alive for
 * `navigator.share` (an `await` before the call would consume it). Falls back
 * to disk only when the content is empty — no session, or one still loading
 * (`content()` is `''` until its async `load()` lands), where `??` alone
 * would share blank text.
 */
export async function shareNote(path: string): Promise<void> {
  const live = openSession(path)?.content()
  const source = live !== undefined && live.trim() !== '' ? live : await readNote(path)
  const text = splitFrontmatter(source).body.trimStart()
  await navigator.share({ title: noteTitle(path), text })
}

/** The basename without its `.md` — the note's working title (Plan 17). */
function noteTitle(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}
