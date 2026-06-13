import {
  assertCloudAllowed,
  createGist,
  errorMessage,
  getGithubToken,
  gistBodyHash,
  gistFilename,
  parseNote,
  ReflectError,
  splitFrontmatter,
  updateGist,
  upsertFrontmatter,
  writeNote,
  type GistFrontmatter,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents'
import { readNoteOrEmpty } from '@/lib/note-read'
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
 * Reads through the live session when the note is open and lands the
 * frontmatter through `commitFrontmatter`, exactly like the pin/private
 * toggles: a direct disk write under a dirty buffer would park a conflict
 * caused by our own action. With no live session (or one that can't take
 * patches), a read-patch-write on disk is reconciled like an external change.
 *
 * `private: true` is the hard block: the gate runs on the content actually
 * being published (live, not the possibly-lagging index), and it fails
 * closed before any byte leaves the device.
 */
export async function publishNoteToGist(path: string, generation: number): Promise<string> {
  const owner = openSession(path)
  const source = owner !== null ? owner.content() : await readNoteOrEmpty(path)
  const parsed = parseNote({ path, source })
  assertCloudAllowed({ path, isPrivate: parsed.frontmatter.private })

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
      ? await updateGist(token, previous.id, previous.file, { filename, content: body }, providerFetch)
      : null) ?? (await createGist(token, { filename, content: body }, providerFetch))

  const gist: GistFrontmatter = {
    id: published.id,
    url: published.htmlUrl,
    file: filename,
    hash: gistBodyHash(body),
  }
  if (owner === null || !(await owner.commitFrontmatter({ gist }))) {
    const onDisk = await readNoteOrEmpty(path)
    await writeNote(path, upsertFrontmatter(onDisk, { gist }), generation)
  }
  return published.htmlUrl
}

/**
 * The publish action as both entry points run it (Note actions button, ⌘K
 * command): publish, copy the gist link, and surface progress through the
 * operations status line — the second short-lived entry is the only success
 * feedback ("Gist link copied"), in keeping with no-toast feedback. Returns
 * the gist url, or `null` when the publish failed (already surfaced).
 */
export async function runGistPublish(path: string, generation: number): Promise<string | null> {
  const operation = startOperation('Publishing gist')
  try {
    const url = await publishNoteToGist(path, generation)
    await navigator.clipboard.writeText(url)
    operation.done()
    startOperation('Gist link copied').done()
    return url
  } catch (cause) {
    operation.fail(errorMessage(cause))
    return null
  }
}
