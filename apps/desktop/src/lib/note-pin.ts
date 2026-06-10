import { isAppError, parseNote, readNote, upsertFrontmatter, writeNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/**
 * Toggle a note's `pinned: true` frontmatter flag. Markdown is the source of
 * truth: the flag lands in the file, the watcher re-indexes it, and the
 * sidebar's Pinned section follows from the index — no UI-side pin state.
 *
 * Routes through the live session whenever the note is open (the same liveness
 * contract as the rename coordinator's alias placement): a direct disk write
 * under a dirty buffer would park a conflict caused by our own action, and
 * "keep mine" would silently undo the pin. With no live session (or one that
 * can't take patches), a read-patch-write on disk is reconciled by any
 * loading/clean session like an external change.
 *
 * A session with a **parked conflict** accepts the patch but pauses its saves
 * until the user resolves — the pin would ride the in-memory header (landing
 * with "keep mine") while the index, and so the sidebar, saw nothing, and
 * "load theirs" would drop it entirely. So under a conflict the contested
 * disk content is patched too — the pin is indexed now and survives either
 * resolution — and the session is nudged to reconcile immediately so the
 * parked snapshot itself picks up the pinned content: an instant "load
 * theirs" must adopt it rather than racing the watcher's echo of our write.
 *
 * Returns the note's new pinned state.
 */
export async function toggleNotePinned(path: string, generation: number): Promise<boolean> {
  const owner = openSession(path)
  if (owner !== null) {
    const pinned = !parseNote({ path, source: owner.content() }).frontmatter.pinned
    if (owner.updateFrontmatter({ pinned })) {
      // Flushed rather than riding the save debounce: a pin should show up in
      // the sidebar now, not 800ms from now.
      await owner.flush()
      if (owner.conflicted()) {
        await applyPinnedToDisk(path, pinned, generation)
        owner.externalChanged()
      }
      return pinned
    }
  }
  const content = await readNoteOrEmpty(path)
  const pinned = !parseNote({ path, source: content }).frontmatter.pinned
  await applyPinnedToDisk(path, pinned, generation, content)
  return pinned
}

/**
 * The note's content, where a missing file reads as an empty note — the lazy
 * contract: dailies (and ⌘N notes) are valid pin targets before their file
 * exists, and the pin write is what creates the file. Covers the gap where the
 * pane's session exists but can't take patches yet (still loading) — its
 * post-load reconcile then adopts our write like any external change.
 */
async function readNoteOrEmpty(path: string): Promise<string> {
  try {
    return await readNote(path)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}

/**
 * Write the target `pinned` state into the note's on-disk content (a no-op
 * write-wise when disk already agrees). The target is applied, never
 * re-toggled, so a disk copy that diverges from the session's view (the
 * conflict case) converges on the user's intent. Unpinning deletes the key —
 * unpinned is the absence of the flag, not `pinned: false` litter.
 */
async function applyPinnedToDisk(
  path: string,
  pinned: boolean,
  generation: number,
  content?: string,
): Promise<void> {
  const current = content ?? (await readNote(path))
  const patched = upsertFrontmatter(current, { pinned: pinned ? true : undefined })
  if (patched !== current) {
    await writeNote(path, patched, generation)
  }
}
