import {
  assertCloudAllowed,
  createGist,
  deleteGist,
  errorMessage,
  getGithubToken,
  gistBodyHash,
  gistFilename,
  parseNote,
  ReflectError,
  splitFrontmatter,
  updateGist,
  type GistFrontmatter,
} from '@reflect/core'
import { setNoteRowOverlay } from '@/hooks/note-row-overlay'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'

/**
 * Publish a note's body to a GitHub Gist (always secret), recording the gist
 * in the note's `gist` frontmatter block. A note that already carries the
 * block republishes to the **same** gist — addressing the file by the name it
 * was last published under, so a title change renames instead of adding a
 * second file. A gist deleted on github.com falls back to creating a fresh
 * one. The stored hash is of the body as published, so the indexer's
 * `gist_stale` reflects real edits, never the frontmatter write itself.
 *
 * Reads and writes through the shared {@link readNoteSource} /
 * {@link commitNoteFrontmatter} channel, exactly like the pin/private toggles:
 * a direct disk write under a dirty buffer would park a conflict caused by our
 * own action, and a still-loading session is read from disk rather than from
 * its empty placeholder buffer.
 *
 * `private: true` is the hard block: the gate runs on the content actually
 * being published (live, not the possibly-lagging index), and it fails
 * closed before any byte leaves the device.
 */
export async function publishNoteToGist(path: string, generation: number): Promise<string> {
  const source = await readNoteSource(path)
  const parsed = parseNote({ path, source })
  assertCloudAllowed({ path, isPrivate: parsed.frontmatter.private })

  // The gist must be recorded in frontmatter or the next publish forks a new
  // one — and `upsertFrontmatter` rightly refuses to rewrite a header it
  // can't parse. That refusal must come *before* the gist exists, not after.
  if (parsed.frontmatterWarning !== undefined) {
    throw new ReflectError('parse', 'The note has invalid frontmatter — fix it before publishing')
  }

  const body = splitFrontmatter(source).body
  if (body.trim() === '') {
    throw new ReflectError('io', 'The note is empty — nothing to publish')
  }

  const token = await getGithubToken(providerFetch)
  if (token === null) {
    throw new ReflectError('auth', 'Connect GitHub in Settings to publish gists')
  }

  const filename = gistFilename(parsed.title)
  const previous = parsed.frontmatter.gist
  const published =
    (previous !== undefined
      ? await updateGist(token, previous.id, previous.file, { name: filename, content: body }, providerFetch)
      : null) ?? (await createGist(token, { name: filename, content: body }, providerFetch))

  const gist: GistFrontmatter = {
    id: published.id,
    url: published.htmlUrl,
    file: filename,
    hash: gistBodyHash(body),
  }
  try {
    await commitNoteFrontmatter(path, { gist }, generation)
  } catch (cause) {
    // The remote and local halves can't be atomic; compensate instead. A
    // *freshly created* gist with no local record would be orphaned (and
    // re-created on the next publish), so best-effort delete it. A failed
    // *republish* record keeps the old block — same gist next time — and the
    // existing gist must never be deleted out from under its shared link.
    if (previous === undefined || published.id !== previous.id) {
      try {
        await deleteGist(token, published.id, providerFetch)
      } catch {
        // Best effort — the publish failure below is the error that matters.
      }
    }
    throw cause
  }
  return published.htmlUrl
}

/**
 * Delete the note's published GitHub Gist and remove the local `gist`
 * frontmatter block. A missing local block is already unpublished, so this is a
 * no-op. The local record is cleared before the remote delete, so a local write
 * failure cannot leave Reflect pointing at a dead link. If GitHub rejects the
 * delete, the local block is restored before the error is surfaced.
 */
export async function unpublishNoteGist(path: string, generation: number): Promise<void> {
  const source = await readNoteSource(path)
  const parsed = parseNote({ path, source })
  if (parsed.frontmatterWarning !== undefined) {
    throw new ReflectError('parse', 'The note has invalid frontmatter — fix it before unpublishing')
  }

  const previous = parsed.frontmatter.gist
  if (previous === undefined) {
    return
  }

  const token = await getGithubToken(providerFetch)
  if (token === null) {
    throw new ReflectError('auth', 'Connect GitHub in Settings to unpublish gists')
  }

  await commitNoteFrontmatter(path, { gist: false }, generation)
  try {
    await deleteGist(token, previous.id, providerFetch)
  } catch (cause) {
    await commitNoteFrontmatter(path, { gist: previous }, generation)
    throw cause
  }
}

/**
 * The publish action as both entry points run it (Note actions button, ⌘K
 * command): publish, copy the gist link, and surface progress through the
 * operations status line — the second short-lived entry is the only success
 * feedback ("Gist link copied"), in keeping with no-toast feedback. Returns
 * the gist url whenever the publish itself landed — a failed clipboard copy
 * (focus, permissions) gets its own failure line, never a phantom "publish
 * failed" for a gist that exists — or `null` when the publish failed
 * (already surfaced).
 *
 * On success it records the url in the optimistic note-row overlay, so every
 * sidebar surface (the gist action's label, the Published URL section)
 * reflects the publish immediately, before the watcher re-indexes the file.
 */
export async function runGistPublish(path: string, generation: number): Promise<string | null> {
  const operation = startOperation('Publishing gist')
  let url: string
  try {
    url = await publishNoteToGist(path, generation)
  } catch (cause) {
    operation.fail(errorMessage(cause))
    return null
  }
  operation.done()
  // Stamp the optimism with the publishing graph's generation, so a publish
  // that resolves after a graph switch can't surface on the new graph.
  setNoteRowOverlay(path, generation, { gistUrl: url, gistStale: false })
  try {
    await navigator.clipboard.writeText(url)
    startOperation('Gist link copied').done()
  } catch (cause) {
    startOperation('Copying the gist link').fail(errorMessage(cause))
  }
  return url
}

/**
 * The unpublish action as the sidebar runs it: delete the remote gist, clear
 * the local gist metadata, and hide the published URL optimistically while the
 * index catches up.
 */
export async function runGistUnpublish(path: string, generation: number): Promise<boolean> {
  const operation = startOperation('Unpublishing gist')
  try {
    await unpublishNoteGist(path, generation)
  } catch (cause) {
    operation.fail(errorMessage(cause))
    return false
  }
  operation.done()
  setNoteRowOverlay(path, generation, { gistUrl: null, gistStale: false })
  return true
}
