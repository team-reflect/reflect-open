import { describe, expect, it } from 'vitest'
import type { ChatTurn } from '@reflect/core'
import { assistantReplyMarkdown } from './chat-copy'

function turnWith(parts: ChatTurn['parts']): ChatTurn {
  return {
    id: 'turn-1',
    userText: 'hi',
    attachments: [],
    parts,
    responseMessages: [],
    status: 'done',
  }
}

describe('assistantReplyMarkdown', () => {
  it('joins the answer text around tool activity, leaving the chrome behind', () => {
    const turn = turnWith([
      { kind: 'text', text: 'Looking it up.' },
      {
        kind: 'tool',
        call: { tool: 'search', toolCallId: 'tool-1', query: 'atlas' },
        result: { tool: 'search', toolCallId: 'tool-1', query: 'atlas', hits: [] },
        error: null,
      },
      { kind: 'text', text: 'It ships in June. [[Atlas]]\n' },
      { kind: 'notice', tone: 'info', text: 'Stopped.' },
    ])

    expect(assistantReplyMarkdown(turn)).toBe('Looking it up.\n\nIt ships in June. [[Atlas]]')
  })

  it('has nothing to copy when the turn produced no answer text', () => {
    const turn = turnWith([
      { kind: 'text', text: '   ' },
      { kind: 'notice', tone: 'error', text: 'The provider refused the request.' },
    ])

    expect(assistantReplyMarkdown(turn)).toBeNull()
  })
})
