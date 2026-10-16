import type { ReactElement } from 'react'
import { parseConflictMarkers, type ConflictSide } from '@reflect/core'
import { cn } from '@/lib/utils.ts'

/**
 * The dot classes for the two sides of a conflict block. Exported so the
 * resolution buttons ({@link SyncConflictNotice}) can carry the same color
 * dot as the version they keep — the color is the coordination between
 * "what you see" and "what the button does". Palette per the design system's
 * restraint rule (indigo is the only saturated accent): this device wears
 * the brand accent, the other device stays cool grey.
 */
export const CONFLICT_SIDE_DOT: Record<'ours' | 'theirs', string> = {
  ours: 'bg-accent',
  theirs: 'bg-gray-400 dark:bg-gray-500',
}

const SIDE_TONES: Record<'ours' | 'theirs', { header: string; block: string }> = {
  ours: {
    header: 'text-accent',
    block: 'bg-accent/8',
  },
  theirs: {
    header: 'text-text-secondary',
    block: 'bg-surface-sunken',
  },
}

interface ConflictNoteViewProps {
  /** The full file content (frontmatter included — honest display). */
  content: string
}

/**
 * The read-only view for a note that an older version left with conflict
 * markers. The file's text is rendered
 * verbatim, with each conflict block shown as a card whose two sides are
 * color-coded and labeled with the device names from the marker lines
 * (instead of raw `<<<<<<<` noise). Display only — resolution is still the
 * raw-file splice in `useConflictResolution`, and `parseConflictMarkers`
 * shares its state machine, so a highlighted side is exactly what the
 * matching "Keep" button keeps. An unterminated block renders verbatim as
 * text rather than pretending to be resolvable.
 */
export function ConflictNoteView({ content }: ConflictNoteViewProps): ReactElement {
  const segments = parseConflictMarkers(content)
  return (
    <div className="reflect-protected-note text-sm leading-relaxed">
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <pre key={index} className="whitespace-pre-wrap">
            {segment.text}
          </pre>
        ) : (
          <div key={index} className="my-3 overflow-hidden rounded-lg border border-border">
            <ConflictSideView side={segment.ours} tone="ours" />
            <ConflictSideView side={segment.theirs} tone="theirs" />
          </div>
        ),
      )}
    </div>
  )
}

interface ConflictSideViewProps {
  side: ConflictSide
  tone: 'ours' | 'theirs'
}

function ConflictSideView({ side, tone }: ConflictSideViewProps): ReactElement {
  const tones = SIDE_TONES[tone]
  return (
    <div className={cn('px-3 py-2', tones.block, tone === 'theirs' && 'border-t border-border')}>
      <div className={cn('mb-1 flex items-center gap-1.5 text-xs font-medium', tones.header)}>
        <span aria-hidden className={cn('size-2 rounded-full', CONFLICT_SIDE_DOT[tone])} />
        {side.label}
      </div>
      {side.text.length > 0 ? (
        <pre className="whitespace-pre-wrap">{side.text}</pre>
      ) : (
        <p className="text-xs text-text-muted italic">Empty on this side</p>
      )}
    </div>
  )
}
