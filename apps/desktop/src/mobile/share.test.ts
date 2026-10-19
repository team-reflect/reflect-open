import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSession } from '@reflect/core'
import { createTestAppServices } from '@reflect/app/testing'
import { createNodeTestDatabaseService, createTestCoreServices } from '@reflect/core/testing'
import { shareNote } from './share.ts'

const shareMock = vi.fn<(data: ShareData) => Promise<void>>()

beforeEach(() => {
  Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock })
  shareMock.mockReset()
  shareMock.mockResolvedValue(undefined)
})

describe('shareNote', () => {
  // What a note shares is covered with `ShareService` in `@reflect/app`.
  it('hands the live editor buffer body to the OS share sheet', async () => {
    const core = createTestCoreServices({ database: createNodeTestDatabaseService() })
    const { openDocuments } = core
    const { share } = createTestAppServices(core)
    // A stand-in implements only what the code under test calls.
    const session: Partial<NoteSession> = {
      path: 'notes/meeting-notes.md',
      liveContent: () => '---\nid: abc123\n---\n# Meeting\n\nAgenda + the unsaved line.\n',
    }
    openDocuments.register({ session: session as NoteSession })

    await shareNote(share, 'notes/meeting-notes.md')

    expect(shareMock).toHaveBeenCalledWith({
      title: 'meeting-notes',
      text: '# Meeting\n\nAgenda + the unsaved line.\n',
    })
  })
})
