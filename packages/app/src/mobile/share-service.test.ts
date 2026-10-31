import { describe, expect, it } from 'vitest'
import type { NoteSession } from '@reflect/core'
import { createNodeTestDatabaseService, createTestCoreServices } from '@reflect/core/testing'
import { createShareService, noteShareContent } from './share-service.ts'

/**
 * A share service with one open note whose live buffer is `liveContent`.
 */
function setup(liveContent: string | null, path = 'notes/meeting-notes.md') {
  const { openDocuments } = createTestCoreServices({ database: createNodeTestDatabaseService() })
  // A stand-in implements only what the service calls.
  openDocuments.register({ session: { path, liveContent: () => liveContent } as NoteSession })
  return createShareService({ openDocuments })
}

describe('noteShareContent', () => {
  it('strips the frontmatter and the leading whitespace of the body', () => {
    expect(noteShareContent('---\nid: abc123\n---\n\n\n# Meeting\n', 'notes/a.md')).toEqual({
      title: 'a',
      text: '# Meeting\n',
    })
  })

  it('titles the content with the basename, without its .md', () => {
    expect(noteShareContent('', 'daily/2026-07-04.md').title).toBe('2026-07-04')
    expect(noteShareContent('', 'top-level.md').title).toBe('top-level')
    expect(noteShareContent('', 'assets/photo.png').title).toBe('photo.png')
  })
})

describe('ShareService', () => {
  it('shares the live editor buffer body (frontmatter stripped, title as subject)', () => {
    const share = setup('---\nid: abc123\n---\n# Meeting\n\nAgenda + the unsaved line.\n')

    expect(share.noteContent('notes/meeting-notes.md')).toEqual({
      title: 'meeting-notes',
      text: '# Meeting\n\nAgenda + the unsaved line.\n',
    })
  })

  it('shares the empty body when a ready note was cleared (not stale content)', () => {
    const share = setup('')

    expect(share.noteContent('notes/meeting-notes.md')).toEqual({
      title: 'meeting-notes',
      text: '',
    })
  })

  it('shares empty rather than reading disk while the session is still loading', () => {
    // liveContent() is null until load() lands; reading disk here would
    // require an await and break the Web Share transient activation.
    const share = setup(null)

    expect(share.noteContent('notes/meeting-notes.md')).toEqual({
      title: 'meeting-notes',
      text: '',
    })
  })

  it('shares empty for a note that is not open', () => {
    const share = setup('# Other\n', 'notes/other.md')

    expect(share.noteContent('notes/meeting-notes.md')).toEqual({
      title: 'meeting-notes',
      text: '',
    })
  })
})
