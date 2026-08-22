import { createPatch } from 'diff'
import { splitFrontmatter } from '@reflect/core'
import { useMemo, type ReactElement } from 'react'
import { cn } from '@/lib/utils'

interface ChatChangeDiffProps {
  path: string
  beforeSource: string | null
  afterSource: string
}

interface DiffLine {
  key: string
  kind: 'added' | 'removed' | 'context' | 'hunk'
  text: string
}

function patchLines(path: string, beforeSource: string | null, afterSource: string): DiffLine[] {
  const created = beforeSource === null
  const before = beforeSource ?? ''
  const after = created ? splitFrontmatter(afterSource).body : afterSource
  const patch = createPatch(path, before, after, '', '', { context: 3 })

  return patch
    .split('\n')
    .slice(4)
    .filter((line) => line !== String.raw`\ No newline at end of file`)
    .map((line, index) => ({
      key: `${index}:${line}`,
      kind: line.startsWith('@@')
        ? 'hunk'
        : line.startsWith('+')
          ? 'added'
          : line.startsWith('-')
            ? 'removed'
            : 'context',
      text: line,
    }))
}

/** A compact, local-only unified Markdown diff for one changed note. */
export function ChatChangeDiff({
  path,
  beforeSource,
  afterSource,
}: ChatChangeDiffProps): ReactElement {
  const createdFrontmatter = useMemo(() => {
    if (beforeSource !== null) {
      return null
    }
    const bodyOffset = splitFrontmatter(afterSource).bodyOffset
    return bodyOffset === 0 ? null : afterSource.slice(0, bodyOffset)
  }, [afterSource, beforeSource])
  const lines = useMemo(
    () => patchLines(path, beforeSource, afterSource),
    [afterSource, beforeSource, path],
  )

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {createdFrontmatter !== null ? (
        <details className="border-b border-border text-xs text-text-muted">
          <summary className="cursor-pointer px-3 py-1.5">Generated note metadata</summary>
          <pre
            aria-label={`Generated metadata for ${path}`}
            className="overflow-x-auto border-t border-border bg-secondary/40 px-3 py-2 font-mono leading-5"
          >
            {createdFrontmatter
              .trimEnd()
              .split(/\r?\n/)
              .map((line) => `+${line}`)
              .join('\n')}
          </pre>
        </details>
      ) : null}
      <pre
        aria-label={`Changes to ${path}`}
        className="max-h-[55dvh] overflow-auto py-2 font-mono text-xs leading-5"
      >
        {lines.map((line) => (
          <span
            key={line.key}
            className={cn(
              'block min-w-max px-3 whitespace-pre-wrap',
              line.kind === 'added' && 'bg-[var(--green-500)]/10 text-[var(--green-500)]',
              line.kind === 'removed' && 'bg-destructive/10 text-destructive',
              line.kind === 'hunk' && 'my-1 bg-secondary text-text-muted',
              line.kind === 'context' && 'text-text-muted',
            )}
          >
            {line.text === '' ? ' ' : line.text}
          </span>
        ))}
      </pre>
    </div>
  )
}
