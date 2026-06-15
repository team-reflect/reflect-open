import type { ReactElement, ReactNode } from 'react'
import type { OpenTask } from '@reflect/core'
import { formatShortDate, isIsoDate } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'

/** The checkbox marker at the start of `raw` (`[ ] ` / `[x] `). */
const MARKER_RE = /^\[[ xX]\]\s?/
/** A `[[wiki]]`, a `[text](href)` link, or a bare URL — the inline bits we style. */
const INLINE_RE = /\[\[([^\]\n]+)\]\]|\[([^\]\n]*)\]\(([^)\n]+)\)|(https?:\/\/[^\s)]+)/g

/**
 * Render a task's inline content (its source line minus the checkbox marker) for
 * the Tasks view: a `[[YYYY-MM-DD]]` link renders as a blue short date (V1's due
 * chip), other `[[wiki]]` links and markdown/bare URLs render as blue text, and
 * everything else as plain text. Read-only and single-line — it styles `raw`
 * directly rather than re-parsing the document.
 */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  const { settings } = useSettings()
  const body = task.raw.replace(MARKER_RE, '')
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0

  for (const match of body.matchAll(INLINE_RE)) {
    const start = match.index ?? 0
    if (start > cursor) {
      nodes.push(body.slice(cursor, start))
    }
    const [full, wiki, mdText, mdHref, url] = match
    let label: string
    if (wiki !== undefined) {
      const pipe = wiki.indexOf('|')
      const target = (pipe === -1 ? wiki : wiki.slice(0, pipe)).trim()
      const alias = pipe === -1 ? '' : wiki.slice(pipe + 1).trim()
      // An explicit alias is the author's display text — honour it even for a
      // date target; otherwise format a date, else show the bare target.
      label = alias || (isIsoDate(target) ? formatShortDate(target, settings.dateFormat) : target)
    } else if (mdHref !== undefined) {
      label = mdText || mdHref
    } else {
      label = url ?? full
    }
    nodes.push(
      <span key={key} className="text-accent">
        {label}
      </span>,
    )
    key += 1
    cursor = start + full.length
  }
  if (cursor < body.length) {
    nodes.push(body.slice(cursor))
  }

  return <span>{nodes}</span>
}
