const TITLE_MAX_CHARS = 60

/** Title for a conversation row: its first message, cut to list length. */
export function conversationTitle(firstUserText: string): string {
  const trimmed = firstUserText.trim().replaceAll(/\s+/g, ' ')
  if (trimmed === '') {
    return 'New chat'
  }
  return trimmed.length > TITLE_MAX_CHARS ? `${trimmed.slice(0, TITLE_MAX_CHARS)}…` : trimmed
}
