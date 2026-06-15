import type { ReactElement } from 'react'
import { scanInlineSegments, type OpenTask } from '@reflect/core'
import { formatShortDate, isIsoDate } from '@/lib/dates'
import { taskContent } from '@/lib/tasks/task-content'
import { useSettings } from '@/providers/settings-provider'

/**
 * Render a task's inline content (its source line minus the checkbox marker) for
 * the Tasks view. The marker is stripped through the shared parseTaskMarker
 * grammar ({@link taskContent}), and inline structure comes from the shared Lezer
 * grammar via {@link scanInlineSegments} — neither uses a regex — so a
 * `[[YYYY-MM-DD]]` link renders as a blue short date (V1's due chip), other
 * `[[wiki]]` links and markdown/bare-URL links render as blue text, and a
 * `[[link]]`/URL inside a code span stays literal, exactly as the editor and
 * indexer see it.
 */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  const { settings } = useSettings()
  const segments = scanInlineSegments(taskContent(task.raw))

  return (
    <span>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return segment.text
        }
        if (segment.kind === 'wikiLink') {
          const label =
            segment.alias ||
            (isIsoDate(segment.target)
              ? formatShortDate(segment.target, settings.dateFormat)
              : segment.target)
          return (
            <span key={index} className="text-accent">
              {label}
            </span>
          )
        }
        return (
          <span key={index} className="text-accent">
            {segment.text || segment.href}
          </span>
        )
      })}
    </span>
  )
}
