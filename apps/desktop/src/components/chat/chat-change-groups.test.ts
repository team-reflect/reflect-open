import type { ChatNoteChange } from '@reflect/core'
import { describe, expect, it } from 'vitest'
import { groupChatNoteChanges } from './chat-change-groups'

function change(overrides: Partial<ChatNoteChange> = {}): ChatNoteChange {
  return {
    id: 'change-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    path: 'notes/project.md',
    sequence: 0,
    operation: 'edit',
    beforeSource: '# Project\n\nBefore\n',
    afterSource: '# Project\n\nMiddle\n',
    beforeRevision: 'a'.repeat(64),
    afterRevision: 'b'.repeat(64),
    state: 'applied',
    errorMessage: null,
    createdMs: 1,
    updatedMs: 2,
    ...overrides,
  }
}

describe('groupChatNoteChanges', () => {
  it('aggregates one path from its first before-state through its final after-state', () => {
    const first = change()
    const second = change({
      id: 'change-2',
      toolCallId: 'tool-2',
      sequence: 1,
      operation: 'append',
      beforeSource: first.afterSource,
      afterSource: '# Project\n\nMiddle\n\nAdded\n',
    })

    expect(groupChatNoteChanges([second, first])).toEqual([
      {
        path: 'notes/project.md',
        title: 'Project',
        changeIds: ['change-1', 'change-2'],
        beforeSource: first.beforeSource,
        afterSource: second.afterSource,
        state: 'applied',
        addedLines: 3,
        removedLines: 1,
      },
    ])
  })

  it('keeps uncertain and unfinalized prepared changes reviewable', () => {
    const uncertain = change({ state: 'uncertain' })
    const failed = change({
      id: 'change-failed',
      toolCallId: 'tool-failed',
      path: 'notes/failed.md',
      state: 'failed',
    })
    const prepared = change({
      id: 'change-prepared',
      toolCallId: 'tool-prepared',
      path: 'notes/prepared.md',
      state: 'prepared',
    })

    expect(groupChatNoteChanges([failed, uncertain, prepared])).toMatchObject([
      { path: prepared.path, state: 'uncertain' },
      { path: uncertain.path, state: 'uncertain' },
    ])
  })

  it('treats an interrupted Undo claim as requiring recovery review', () => {
    expect(groupChatNoteChanges([change({ state: 'undoing' })])).toMatchObject([
      { path: 'notes/project.md', state: 'uncertain' },
    ])
  })

  it('hides generated frontmatter from creation statistics', () => {
    const created = change({
      operation: 'create',
      beforeSource: null,
      beforeRevision: null,
      afterSource: '---\nid: 01abc\n---\n# Launch notes\n\nFirst line\n',
      path: 'notes/launch-notes.md',
    })

    expect(groupChatNoteChanges([created])).toMatchObject([
      {
        title: 'Launch notes',
        addedLines: 3,
        removedLines: 0,
      },
    ])
  })
})
