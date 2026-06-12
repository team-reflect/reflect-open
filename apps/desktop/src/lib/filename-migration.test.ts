import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { registerOpenDocument } from '@/editor/open-documents'
import type { NoteSession } from '@/editor/note-session'
import { findMigrationCandidates, migrateUlidNotes } from './filename-migration'

/**
 * The 17c migration runner over a fake graph: a files map behind the bridge,
 * with `db_query` answering both the candidate list (note rows) and the
 * collision probe (path lookups) from the same map.
 */

const ULID_A = '01arz3ndektsv4rrffq69g5fav'
const ULID_B = '01brz3ndektsv4rrffq69g5fbw'

let files: Record<string, string>

function bindBridge(): void {
  setBridge({
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'note_read') {
        const content = files[String(args?.path)]
        if (content === undefined) {
          throw { kind: 'notFound', message: 'missing' }
        }
        return content
      }
      if (command === 'note_write') {
        files[String(args?.path)] = String(args?.contents)
        return null
      }
      if (command === 'note_exists') {
        return files[String(args?.path)] !== undefined
      }
      if (command === 'note_move_indexed') {
        const from = String(args?.from)
        const to = String(args?.to)
        if (files[to] === undefined && files[from] !== undefined) {
          files[to] = files[from]
        }
        delete files[from]
        return null
      }
      if (command === 'db_query') {
        const sql = String(args?.sql)
        if (sql.includes('"tags"') || sql.includes('has_conflict')) {
          return []
        }
        if (sql.includes('"path" = ')) {
          // The collision probe: one path lookup.
          const candidate = String((args?.params as unknown[])[0])
          return files[candidate] !== undefined ? [{ path: candidate }] : []
        }
        // The note list: derive rows from the files map (title = H1 or stem).
        return Object.entries(files).map(([path, content]) => {
          const h1 = /^#\s+(.+)$/m.exec(content)
          const stem = path.replace(/^notes\//, '').replace(/\.md$/, '')
          return { path, title: h1?.[1] ?? stem, mtime: 0, preview: '' }
        })
      }
      return null
    },
    listen: async () => () => {},
  })
}

beforeEach(() => {
  files = {}
  bindBridge()
})

afterEach(() => {
  setBridge(null)
})

describe('findMigrationCandidates', () => {
  it('selects titled ULID-named notes; untitled and slug-named ones stay put', async () => {
    files[`notes/${ULID_A}.md`] = '# Real Title\n'
    files[`notes/${ULID_B}.md`] = 'no heading here\n' // untitled: title = stem
    files['notes/already-named.md'] = '# Already Named\n'

    await expect(findMigrationCandidates()).resolves.toEqual([
      { path: `notes/${ULID_A}.md`, title: 'Real Title' },
    ])
  })
})

describe('migrateUlidNotes', () => {
  it('stamps a missing id and moves the file onto its slug path', async () => {
    files[`notes/${ULID_A}.md`] = '# Real Title\n'

    const result = await migrateUlidNotes({
      candidates: [{ path: `notes/${ULID_A}.md`, title: 'Real Title' }],
      generation: 3,
    })

    expect(result).toEqual({ moved: 1, skipped: 0, failed: [] })
    expect(files[`notes/${ULID_A}.md`]).toBeUndefined()
    expect(files['notes/real-title.md']).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# Real Title\n$/)
  })

  it('keeps an existing id untouched (idempotent re-run)', async () => {
    const content = '---\nid: 01existing00000000000000000\n---\n# Real Title\n'
    files[`notes/${ULID_A}.md`] = content

    await migrateUlidNotes({
      candidates: [{ path: `notes/${ULID_A}.md`, title: 'Real Title' }],
      generation: 3,
    })

    expect(files['notes/real-title.md']).toBe(content)
  })

  it('suffixes when the slug is taken', async () => {
    files['notes/real-title.md'] = '# Another Note\n'
    files[`notes/${ULID_A}.md`] = '# Real Title\n'

    await migrateUlidNotes({
      candidates: [{ path: `notes/${ULID_A}.md`, title: 'Real Title' }],
      generation: 3,
    })

    expect(files['notes/real-title-2.md']).toContain('# Real Title')
    expect(files['notes/real-title.md']).toBe('# Another Note\n') // untouched
  })

  it('skips conflicted, open, and since-untitled notes; reports progress for all', async () => {
    const conflicted = `notes/${ULID_A}.md`
    files[conflicted] = '<<<<<<< mine\n# A\n=======\n# B\n>>>>>>> theirs\n'
    const open = `notes/${ULID_B}.md`
    files[open] = '# Open Note\n'
    const session: NoteSession = {
      path: open,
      retarget: () => {},
      load: () => {},
      editorChanged: () => {},
      externalChanged: () => {},
      flush: async () => {},
      keepMine: () => {},
      loadTheirs: () => {},
      commitFrontmatter: async () => true,
      content: () => files[open],
      updateFrontmatter: () => true,
      dispose: () => {},
    }
    const unregister = registerOpenDocument({ session })
    const progress: Array<[number, number]> = []
    try {
      const result = await migrateUlidNotes({
        candidates: [
          { path: conflicted, title: 'A' },
          { path: open, title: 'Open Note' },
        ],
        generation: 3,
        onProgress: (done, total) => progress.push([done, total]),
      })
      expect(result).toEqual({ moved: 0, skipped: 2, failed: [] })
      expect(progress).toEqual([
        [1, 2],
        [2, 2],
      ])
      expect(files[conflicted]).toBeDefined() // nothing touched
      expect(files[open]).toBe('# Open Note\n')
    } finally {
      unregister()
    }
  })

  it('collects failures and keeps going', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      files[`notes/${ULID_B}.md`] = '# Survivor\n'
      const result = await migrateUlidNotes({
        candidates: [
          { path: `notes/${ULID_A}.md`, title: 'Ghost' }, // file vanished
          { path: `notes/${ULID_B}.md`, title: 'Survivor' },
        ],
        generation: 3,
      })
      expect(result.moved).toBe(1)
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].path).toBe(`notes/${ULID_A}.md`)
      expect(files['notes/survivor.md']).toContain('# Survivor')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
