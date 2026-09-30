import { collectInlineElements, LEZER_NODE_IDS, parseInline } from '@meowdown/markdown'
import { normalizeWikiTarget } from './resolve.ts'

/** A `[[YYYY-MM-DD]]` link inside task text, with its offsets in that text. */
export interface TaskDateLink {
  from: number
  to: number
  date: string
}

/** The wiki links in task text whose target is a calendar date, in order. */
export function taskDateLinks(text: string): TaskDateLink[] {
  const links = collectInlineElements(
    parseInline(text),
    (node) => node.type === LEZER_NODE_IDS.Wikilink || node.type === LEZER_NODE_IDS.WikiEmbed,
  )
  return links.flatMap((node) => {
    const open = node.type === LEZER_NODE_IDS.WikiEmbed ? 3 : 2
    const target = text.slice(node.from + open, node.to - 2).split('|')[0] ?? ''
    const date = normalizeWikiTarget(target).date
    return date === undefined ? [] : [{ from: node.from, to: node.to, date }]
  })
}

/** A task's due date: the first calendar-valid `[[YYYY-MM-DD]]` link in its text, or null. */
export function taskDueDate(text: string): string | null {
  return taskDateLinks(text)[0]?.date ?? null
}
