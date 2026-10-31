import type { ChatTurn } from '@reflect/core'

/**
 * The assistant's answer for one turn as markdown, ready for the clipboard:
 * the turn's text parts joined by blank lines, exactly as the model wrote them
 * (`[[wiki links]]` included, so a pasted reply still links inside a note).
 *
 * Tool activity and notices are chrome around the answer rather than part of
 * it, so they never reach the clipboard. Returns `null` when the turn carries
 * no answer text — the caller renders no copy affordance at all.
 */
export function assistantReplyMarkdown(turn: ChatTurn): string | null {
  const chunks: string[] = []
  for (const part of turn.parts) {
    if (part.kind !== 'text') {
      continue
    }
    const text = part.text.trim()
    if (text !== '') {
      chunks.push(text)
    }
  }
  return chunks.length === 0 ? null : chunks.join('\n\n')
}
