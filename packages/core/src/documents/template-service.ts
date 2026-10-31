import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { errorMessage } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { IndexQueryService } from '../indexing/index-query-service.ts'
import type { NotePathService } from '../indexing/note-path-service.ts'
import { splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter.ts'
import { displayNoteTitle } from '../markdown/note-title.ts'
import { hasAuthoredTitle, parseNote } from '../markdown/extract.ts'
import { slugForTitle } from '../markdown/slug.ts'
import type { NoteMoveService } from './note-move-service.ts'
import type { OpenDocumentsService } from './open-documents-service.ts'

/**

 * The editor a template is inserted into: the part of the editor handle that the insert needs.

 */
export interface TemplateInsertTarget {
  /**
   * Insert markdown at the cursor.
   */
  insertMarkdown(markdown: string): void
  focus(): void
}

/**

 * One template row of the editor's `/` menu.

 */
export interface TemplateSlashItem {
  /**
   * The template's graph-relative path.
   */
  id: string
  label: string
  keywords: string[]
  onSelect: () => void
}

/**
 * Note templates (docs/porting/note-templates.md): markdown files under
 * `templates/`, inserted verbatim at the cursor. This service owns the
 * file-level operations — reading a template's insertable body, inserting
 * it, creating, and renaming — shared by the palette commands, the slash
 * menu, and the settings section.
 */
export interface TemplateService {
  /**
   * The insertable body of a template: its markdown with any frontmatter
   * stripped (v1 parity — template frontmatter is metadata, never content).
   */
  templateBody(path: string): Promise<string>
  /**
   * Insert `path`'s body into `editor` at the cursor and refocus it. Every
   * failure is loud — a missing editor (the routed note is protected or still
   * loading) or a failed read must never be a silent nothing after the user
   * picked a template.
   */
  insertTemplate(path: string, editor: TemplateInsertTarget | null): Promise<void>
  /**
   * The editor's `/` menu rows: every template, A→Z, each inserting through
   * {@link TemplateService.insertTemplate}. `getEditor` is read at select
   * time, not capture time: the menu belongs to exactly one editor, and a
   * late resolve after that pane unmounted must insert nowhere rather than
   * somewhere stale.
   */
  slashItems(getEditor: () => TemplateInsertTarget | null): Promise<TemplateSlashItem[]>
  /**
   * Create a template named `name` at a collision-free `templates/<slug>.md`
   * (the `-2` suffix policy notes use), named via frontmatter `title:` — the
   * v1 split between name (metadata) and body (content): insertion strips
   * frontmatter, so the name never lands in a note as a stray heading. An
   * authored H1 still works (and inserts) when the user wants one. Returns the
   * new graph-relative path. The first template write also creates the
   * `templates/` folder — it is not bootstrapped with the graph (no-litter).
   * Rejects when no graph is open.
   */
  createTemplate(name: string): Promise<string>
  /**
   * Rename a template to `name`: move the file onto the new name's slug
   * (carrying any open editor session) **and** rewrite the authored title the
   * display name derives from — the leading H1 (or a frontmatter `title:`).
   * Without the rewrite, an authored title would keep presenting the old name
   * everywhere no matter where the file lives. A title authored nowhere
   * (filename-only templates) needs no rewrite — the moved filename is the
   * name. Returns the template's (possibly unchanged) path. Rejects when no
   * graph is open.
   */
  renameTemplate(path: string, name: string): Promise<string>
}

export interface TemplateServiceDeps {
  readonly noteFile: NoteFileService
  readonly indexQuery: IndexQueryService
  readonly notePath: NotePathService
  readonly noteMove: NoteMoveService
  readonly openDocuments: OpenDocumentsService
  readonly progress: ProgressPort
  readonly graphSession: GraphSessionSource
}

class TemplateServiceImpl implements TemplateService {
  readonly #deps: TemplateServiceDeps

  constructor(deps: TemplateServiceDeps) {
    this.#deps = deps
  }

  async templateBody(path: string): Promise<string> {
    const { noteFile, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return splitFrontmatter(await noteFile.read(path, generation)).body
  }

  async insertTemplate(path: string, editor: TemplateInsertTarget | null): Promise<void> {
    const { progress } = this.#deps
    if (editor === null) {
      progress.fail('Inserting template', 'No open note to insert into')
      return
    }
    try {
      editor.insertMarkdown(await this.templateBody(path))
      editor.focus()
    } catch (cause) {
      progress.fail('Inserting template', errorMessage(cause))
    }
  }

  async slashItems(getEditor: () => TemplateInsertTarget | null): Promise<TemplateSlashItem[]> {
    const templates = await this.#deps.indexQuery.listTemplates()
    return templates.map((template) => ({
      id: template.path,
      label: displayNoteTitle(template.title),
      // v1 parity: typing `/template` lists every template, whatever its name.
      keywords: ['template'],
      onSelect: () => {
        void this.insertTemplate(template.path, getEditor())
      },
    }))
  }

  async createTemplate(name: string): Promise<string> {
    const { noteFile, notePath, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const title = name.trim()
    const path = await notePath.availableTemplatePath(slugForTitle(title))
    await noteFile.write(path, upsertFrontmatter('', { title }), generation)
    return path
  }

  async renameTemplate(path: string, name: string): Promise<string> {
    const { notePath, noteMove, openDocuments, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const title = name.trim()
    // Flush first so the retitle below edits settled bytes; the move flushes on
    // its own, but a same-slug rename skips the move entirely.
    await openDocuments.sessionFor(path)?.flush()
    const target = await notePath.templateSlugPathForTitle(path, title)
    if (target !== path) {
      await noteMove.moveNote(path, target, generation)
    }
    await this.#retitleTemplate(target, title, generation)
    return target
  }

  /**
   * Rewrite the file's authored title to `title`, if it authors one.
   */
  async #retitleTemplate(path: string, title: string, generation: number): Promise<void> {
    const { noteFile } = this.#deps
    const source = await noteFile.read(path, generation)
    const parsed = parseNote({ path, source })
    const h1 = parsed.headings.find((heading) => heading.level === 1 && heading.text)
    if (h1 !== undefined && h1.text === parsed.title) {
      if (h1.text === title) {
        return
      }
      await noteFile.write(
        path,
        `${source.slice(0, h1.from)}# ${title}${source.slice(h1.to)}`,
        generation,
      )
      return
    }
    if (hasAuthoredTitle(parsed)) {
      // No display-driving H1, so the authored title is frontmatter `title:`.
      await noteFile.write(path, upsertFrontmatter(source, { title }), generation)
    }
  }
}

export function createTemplateService(deps: TemplateServiceDeps): TemplateService {
  return new TemplateServiceImpl(deps)
}
