import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { appendToDaily, createNoteFromCapture } from './capture'

/**
 * The capture write paths (Plan 19, step 9) over a fake IPC bridge: append
 * separates with a blank line, a missing daily starts clean, blank input is
 * a no-op, and new-note splits the first line into the title.
 */

let files: Record<string, string>
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  files = {}
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      const content = files[(args as { path: string }).path]
      if (content === undefined) {
        throw { kind: 'notFound', message: 'missing' } // AppError shape
      }
      return content
    }
    if (command === 'note_write') {
      const { path, contents } = args as { path: string; contents: string }
      files[path] = contents
      return null
    }
    if (command === 'note_exists') {
      return files[(args as { path: string }).path] !== undefined
    }
    if (command === 'db_query') {
      return []
    }
    return null
  })
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('appendToDaily', () => {
  it('appends after a blank line, trimming trailing whitespace first', async () => {
    files['daily/2026-06-12.md'] = 'morning thoughts\n'
    await appendToDaily('2026-06-12', 'captured later', 1)
    expect(files['daily/2026-06-12.md']).toBe('morning thoughts\n\ncaptured later\n')
  })

  it('starts a missing daily with just the text (the lazy-daily contract)', async () => {
    await appendToDaily('2026-06-12', 'first capture', 1)
    expect(files['daily/2026-06-12.md']).toBe('first capture\n')
  })

  it('is a no-op on blank input', async () => {
    await appendToDaily('2026-06-12', '   \n ', 1)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('propagates non-notFound read failures instead of clobbering', async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'note_read') {
        throw { kind: 'io', message: 'disk error' }
      }
      return null
    })
    await expect(appendToDaily('2026-06-12', 'text', 1)).rejects.toMatchObject({ kind: 'io' })
    expect(files['daily/2026-06-12.md']).toBeUndefined()
  })
})

describe('createNoteFromCapture', () => {
  it('titles the note from the first line and bodies the rest', async () => {
    const path = await createNoteFromCapture('Meeting plan\nDiscuss the launch.\nAssign owners.', 1)
    expect(path).toBe('notes/meeting-plan.md')
    expect(files[path ?? '']).toContain('# Meeting plan\n')
    expect(files[path ?? '']).toContain('Discuss the launch.\nAssign owners.\n')
  })

  it('creates a title-only note from a single line', async () => {
    const path = await createNoteFromCapture('Reading list', 1)
    expect(path).toBe('notes/reading-list.md')
    expect(files[path ?? '']).toContain('# Reading list\n')
  })

  it('returns null on blank input without writing', async () => {
    expect(await createNoteFromCapture('  ', 1)).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
