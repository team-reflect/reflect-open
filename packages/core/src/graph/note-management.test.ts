import { describe, expect, it } from 'vitest'
import {
  isReflectManagedNote,
  isReflectManagedNotePath,
  isValidReflectNoteId,
} from './note-management'

const VALID_ID = '01hv3xq7c2dm8k4t9w5e6r1n98'

describe('Reflect-managed notes', () => {
  it('requires a direct notes/*.md path and valid ULID frontmatter', () => {
    const source = `---\nid: ${VALID_ID}\n---\n# Managed\n`
    expect(isReflectManagedNote('notes/managed.md', source)).toBe(true)
    expect(isReflectManagedNote('notes/nested/managed.md', source)).toBe(false)
    expect(isReflectManagedNote('Projects/managed.md', source)).toBe(false)
  })

  it('keeps direct adopted notes without a valid Reflect id unmanaged', () => {
    expect(isReflectManagedNote('notes/adopted.md', '# Adopted\n')).toBe(false)
    expect(isReflectManagedNote('notes/adopted.md', '---\nid: legacy-id\n---\n# Adopted\n')).toBe(
      false,
    )
  })

  it('validates canonical ULIDs case-insensitively and rejects overflow', () => {
    expect(isValidReflectNoteId(VALID_ID)).toBe(true)
    expect(isValidReflectNoteId(VALID_ID.toUpperCase())).toBe(true)
    expect(isValidReflectNoteId(`8${VALID_ID.slice(1)}`)).toBe(false)
    expect(isValidReflectNoteId('not-a-ulid')).toBe(false)
    expect(isValidReflectNoteId(null)).toBe(false)
  })

  it('recognizes only visible direct managed-note paths', () => {
    expect(isReflectManagedNotePath('notes/managed.md')).toBe(true)
    expect(isReflectManagedNotePath('notes/.hidden.md')).toBe(false)
    expect(isReflectManagedNotePath('notes/nested/managed.md')).toBe(false)
    expect(isReflectManagedNotePath('notes/managed.MD')).toBe(false)
  })

  it('matches the notes directory case-insensitively', () => {
    // On a case-insensitive filesystem a pre-existing `Notes/` folder
    // captures Reflect's own writes; the walker then reports that casing and
    // Reflect-created notes must not silently lose slug management.
    expect(isReflectManagedNotePath('Notes/managed.md')).toBe(true)
    // Path casing alone claims nothing: without a valid ULID id the note
    // stays adopted.
    expect(isReflectManagedNote('Notes/adopted.md', '# Adopted\n')).toBe(false)
    const source = `---\nid: ${VALID_ID}\n---\n# Managed\n`
    expect(isReflectManagedNote('Notes/managed.md', source)).toBe(true)
  })
})
