import { describe, expect, it } from 'vitest'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { placeOldTitleAlias } from './alias-placement.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'

/**
 * The pure helpers (`parseNote`, `nextAliases`, `upsertFrontmatter`) stay real
 * so the alias math is exercised, not restated — the same split as the
 * coordinator tests.
 */

const PATH = 'notes/subject.md'
const RENAME = { from: 'Old Title', to: 'New Title', previousAutoAliases: [] }

function setup(options?: {
  /**
   * The file at `PATH`; `null` leaves it missing. Defaults to `# Old Title` with a body.
   */
  disk?: string | null
  /**
   * The open session's buffer; without it no session is open.
   */
  session?: string
  /**
   * False makes the session refuse the patch. Defaults to true.
   */
  takesPatch?: boolean
}) {
  const disk = options?.disk === undefined ? '# Old Title\n\nbody\n' : options.disk
  const noteFile = createTestNoteFileService({ files: disk === null ? {} : { [PATH]: disk } })
  const session =
    options?.session === undefined
      ? null
      : createTestNoteSession({
          path: PATH,
          content: options.session,
          accepts: options.takesPatch ?? true,
        })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  if (session !== null) {
    openDocuments.register({ session })
  }
  return { deps: { noteFile, openDocuments }, noteFile, session }
}

describe('placeOldTitleAlias', () => {
  it('with no live session, patches the alias straight onto disk at the generation', async () => {
    const { deps, noteFile } = setup()

    await placeOldTitleAlias(deps, PATH, RENAME, 7)

    expect(noteFile.writes()).toEqual([
      {
        path: PATH,
        contents: upsertFrontmatter('# Old Title\n\nbody\n', { aliases: ['Old Title'] }),
        generation: 7,
      },
    ])
    expect(noteFile.writes()[0]!.contents).toContain('# Old Title\n\nbody\n') // body untouched
  })

  it('routes through a live session: frontmatter channel, then flush, no disk write', async () => {
    const { deps, noteFile, session } = setup({ disk: null, session: '# Old Title\n\nbody\n' })

    await placeOldTitleAlias(deps, PATH, RENAME, 7)

    expect(session!.getCalls('updateFrontmatter')).toEqual([[{ aliases: ['Old Title'] }]])
    expect(session!.getCalls('flush')).toHaveLength(1)
    expect(noteFile.writes()).toEqual([])
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const { deps, noteFile, session } = setup({
      session: '# Old Title\n\nbody\n',
      takesPatch: false,
    })

    await placeOldTitleAlias(deps, PATH, RENAME, 7)

    expect(session!.getCalls('flush')).toHaveLength(0)
    expect(noteFile.writes()).toHaveLength(1)
  })

  it('writes nothing when the alias would be redundant', async () => {
    // A case-only retitle: the old title folds to the new one, so keeping it
    // as an alias would alias a note to its own title.
    const { deps, noteFile, session } = setup({ session: '# new title\n' })

    await placeOldTitleAlias(deps, PATH, { ...RENAME, from: 'new title' }, 7)

    expect(session!.getCalls('updateFrontmatter')).toEqual([])
    expect(session!.getCalls('flush')).toHaveLength(0)
    expect(noteFile.writes()).toEqual([])
  })

  it('returns the aliases it added, for the next rename in the chain to prune', async () => {
    const { deps, session } = setup({
      session: '---\naliases:\n  - Dad\n---\n# Timothy MacCaw\n',
    })

    const added = await placeOldTitleAlias(
      deps,
      PATH,
      { from: 'Tim MacCaw // Dad', to: 'Timothy MacCaw', previousAutoAliases: [] },
      7,
    )

    expect(added).toEqual(['Tim MacCaw', 'Tim MacCaw // Dad'])
    expect(session!.getCalls('updateFrontmatter')).toEqual([
      [{ aliases: ['Dad', 'Tim MacCaw', 'Tim MacCaw // Dad'] }],
    ])
  })

  it('tracks a segment the previous title still derived once a rename drops it', async () => {
    // First leg: `Alice // Dad` -> `Bob // Dad` added `Alice` and the whole title
    // but not `Dad`, which the new title still derived. Second leg: `Dad` is
    // added for the first time, so it must count as auto-added.
    const { deps, session } = setup({
      session: '---\naliases:\n  - Alice\n  - Alice // Dad\n---\n# Carol\n',
    })

    const added = await placeOldTitleAlias(
      deps,
      PATH,
      { from: 'Bob // Dad', to: 'Carol', previousAutoAliases: ['Alice', 'Alice // Dad'] },
      7,
    )

    expect(added).toEqual(['Bob', 'Dad', 'Bob // Dad'])
    expect(session!.getCalls('updateFrontmatter')).toEqual([
      [{ aliases: ['Bob', 'Dad', 'Bob // Dad'] }],
    ])
  })

  it('computes against the disk contents, preserving concurrently-gained aliases', async () => {
    const { deps, noteFile } = setup({
      disk: '---\naliases:\n  - Keeper\n---\n# New Title\n',
    })

    await placeOldTitleAlias(deps, PATH, RENAME, 7)

    const written = noteFile.getWrites(PATH).at(-1) ?? ''
    expect(written).toContain('Keeper')
    expect(written).toContain('Old Title')
    expect(written.endsWith('# New Title\n')).toBe(true)
  })

  it('computes against the session buffer, preserving concurrently-gained aliases', async () => {
    const { deps, session } = setup({
      session: '---\naliases:\n  - Gained Elsewhere\n---\n# Old Title\n',
    })

    await placeOldTitleAlias(deps, PATH, RENAME, 7)

    expect(session!.getCalls('updateFrontmatter')).toEqual([
      [{ aliases: ['Gained Elsewhere', 'Old Title'] }],
    ])
  })
})
