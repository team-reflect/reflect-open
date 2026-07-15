import {
  createNoteIfAbsent,
  errorMessage,
  hasAuthoredTitle,
  parseNote,
  readNote,
  slugForTitle,
  splitFrontmatter,
  templatePath,
  templateSlugPathForTitle,
  upsertFrontmatter,
  writeNoteIfUnchanged,
} from '@reflect/core'
import { moveNoteCarryingSession } from '@/editor/move-note'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { openSession } from '@/editor/open-documents'
import { startOperation } from '@/lib/operations'

/**
 * Note templates (docs/porting/note-templates.md): markdown files under
 * `templates/`, inserted verbatim at the cursor. This module owns the
 * file-level operations — reading a template's insertable body, inserting it,
 * creating, and renaming — shared by the palette commands, the slash menu,
 * and the settings section.
 */

/**
 * The insertable body of a template: its markdown with any frontmatter
 * stripped (v1 parity — template frontmatter is metadata, never content).
 */
export async function templateBody(path: string): Promise<string> {
  return splitFrontmatter(await readNote(path)).body
}

/**
 * Insert `path`'s body into `editor` at the cursor and refocus it. Every
 * failure is loud — a missing editor (the routed note is protected or still
 * loading) or a failed read must never be a silent nothing after the user
 * picked a template.
 */
export async function insertTemplate(
  path: string,
  editor: Pick<NoteEditorHandle, 'insertMarkdown' | 'focus'> | null,
): Promise<void> {
  if (editor === null) {
    startOperation('Inserting template').fail('No open note to insert into')
    return
  }
  try {
    editor.insertMarkdown(await templateBody(path))
    editor.focus()
  } catch (cause) {
    startOperation('Inserting template').fail(errorMessage(cause))
  }
}

/**
 * Create a template named `name` at a collision-free `templates/<slug>.md`
 * (the `-2` suffix policy notes use), named via frontmatter `title:` — the
 * v1 split between name (metadata) and body (content): insertion strips
 * frontmatter, so the name never lands in a note as a stray heading. An
 * authored H1 still works (and inserts) when the user wants one. Returns the
 * new graph-relative path. The first template write also creates the
 * `templates/` folder — it is not bootstrapped with the graph (no-litter).
 * Each suffix is claimed atomically, so a concurrent winner is preserved and
 * advances this creation to the next suffix without a check-then-write gap.
 */
export async function createTemplate(name: string, generation: number): Promise<string> {
  const title = name.trim()
  const slug = slugForTitle(title)
  const source = upsertFrontmatter('', { title })
  for (let attempt = 1; attempt <= MAX_TEMPLATE_CREATE_ATTEMPTS; attempt += 1) {
    const path = templatePath(attempt === 1 ? slug : `${slug}-${attempt}`)
    const outcome = await createNoteIfAbsent(path, source, generation)
    if (outcome.kind === 'created') {
      return path
    }
  }
  throw new Error(
    `no available template path for slug "${slug}" after ${MAX_TEMPLATE_CREATE_ATTEMPTS} attempts`,
  )
}

/** Far beyond a plausible collision run; fail loud if availability never advances. */
const MAX_TEMPLATE_CREATE_ATTEMPTS = 1000

/**
 * Rename a template to `name`: move the file onto the new name's slug
 * (carrying any open editor session) **and** rewrite the authored title the
 * display name derives from — the leading H1 (or a frontmatter `title:`).
 * Without the rewrite, an authored title would keep presenting the old name
 * everywhere no matter where the file lives. A title authored nowhere
 * (filename-only templates) needs no rewrite — the moved filename is the
 * name. Returns the template's (possibly unchanged) path.
 */
export async function renameTemplate(
  path: string,
  name: string,
  generation: number,
): Promise<string> {
  const title = name.trim()
  // Flush first so the retitle below edits settled bytes; the move flushes on
  // its own, but a same-slug rename skips the move entirely.
  await openSession(path)?.flush()
  const target = await templateSlugPathForTitle(path, title)
  if (target !== path) {
    await moveNoteCarryingSession(path, target, generation)
  }
  await retitleTemplate(target, title, generation)
  return target
}

/** Rewrite the file's authored title to `title`, if it authors one. */
async function retitleTemplate(path: string, title: string, generation: number): Promise<void> {
  const source = await readNote(path)
  const parsed = parseNote({ path, source })
  const h1 = parsed.headings.find((heading) => heading.level === 1 && heading.text)
  if (h1 !== undefined && h1.text === parsed.title) {
    if (h1.text === title) {
      return
    }
    const outcome = await writeNoteIfUnchanged(
      path,
      source,
      `${source.slice(0, h1.from)}# ${title}${source.slice(h1.to)}`,
      generation,
    )
    if (outcome.kind === 'changed') {
      throw new Error('The template changed or was removed before its title update landed.')
    }
    return
  }
  if (hasAuthoredTitle(parsed)) {
    // No display-driving H1, so the authored title is frontmatter `title:`.
    const outcome = await writeNoteIfUnchanged(
      path,
      source,
      upsertFrontmatter(source, { title }),
      generation,
    )
    if (outcome.kind === 'changed') {
      throw new Error('The template changed or was removed before its title update landed.')
    }
  }
}
