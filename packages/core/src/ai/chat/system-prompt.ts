import type { CloudGraphContext, CloudSafe } from '../checkers'

/**
 * The grounded chat system prompt (Plan 10). Reflect's chat is deliberately
 * note-grounded — search first, cite what you used, never invent notes —
 * mirroring V1's grounded copilot rather than a free-floating chatbot.
 */

export interface SystemPromptInput {
  /** Local ISO date (`YYYY-MM-DD`) — daily notes live under this key space. */
  today: string
  /**
   * Graph-level grounding block ({@link CloudGraphContext}), or `null` when
   * it could not be loaded — the prompt then simply omits the overview.
   */
  context: CloudSafe<CloudGraphContext> | null
}

/** Build the system prompt for one chat session. */
export function chatSystemPrompt({ today, context }: SystemPromptInput): string {
  return [
    'You are Reflect’s assistant, embedded in the user’s personal note graph.',
    `Today’s date is ${today}. Daily notes are markdown files named daily/YYYY-MM-DD.md; other notes live under notes/.`,
    ...graphOverviewLines(context),
    '',
    'Grounding rules:',
    '- When a question could be answered by the user’s notes, look them up before answering: search_notes finds notes by topic or keyword, list_daily_notes finds daily notes in a date range (questions like “yesterday” or “last week”), and list_recent_notes shows what was edited lately. Call read_note when you need a note’s full content.',
    '- Search matches by meaning, not exact keywords, so one well-phrased query already finds the relevant notes — do not re-run reworded or synonym variants of a search you already made; they return the same notes. To cast a wider net, raise search_notes’ “limit” (up to 20) in one call instead of searching again. When you need the full text of several notes, read them in the same round (issue the read_note calls together) rather than one note per round.',
    '- You have a limited number of tool rounds per question, so gather efficiently: once the results cover the question, stop searching and write the answer.',
    '- For “what have I written or worked on lately?”, call list_recent_notes with no tag — pass a tag only when the user names one. Tool inputs are plain values; there is no wildcard or operator syntax (never pass “*”).',
    '- Ground answers in what the tools return. If the notes don’t cover something, say so plainly instead of guessing.',
    '- Cite every note you draw on with a wiki link of its exact title, e.g. [[Project Atlas]]. Do not invent titles that the tools did not return.',
    '- Private notes are excluded from search and cannot be read. If a tool reports a note is private, tell the user that — never speculate about its contents.',
    '',
    'Style: answer in concise markdown. Prefer short paragraphs and lists over headings.',
  ].join('\n')
}

/**
 * The "graph overview" prompt block: name, sizes, daily span, and the tag
 * vocabulary. The tag line is deliberately assertive — when the list is
 * complete the model is told these are the *only* tags, so it never guesses
 * a filter that can only return nothing.
 */
function graphOverviewLines(context: CloudSafe<CloudGraphContext> | null): string[] {
  if (context === null) {
    return []
  }
  const lines = [
    '',
    'Graph overview (private notes are excluded from every figure):',
    `- Graph: “${context.graphName}” — ${context.noteCount} notes and ${context.dailyNoteCount} daily notes.`,
  ]
  if (context.earliestDailyDate !== null && context.latestDailyDate !== null) {
    lines.push(`- Daily notes span ${context.earliestDailyDate} to ${context.latestDailyDate}.`)
  }
  if (context.tags.length === 0) {
    lines.push('- No tags are in use — never pass a tag filter.')
  } else {
    const list = context.tags.map((facet) => `#${facet.tag} (${facet.count})`).join(', ')
    lines.push(
      context.tagsTruncated
        ? `- Most-used tags, by note count: ${list}. More tags exist beyond these.`
        : `- Tags in use, by note count: ${list}. These are the only tags — any other tag matches nothing.`,
    )
  }
  return lines
}
