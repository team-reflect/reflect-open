import { parseNote, type ChatNoteChange } from '@reflect/core'
import { changedLineStatistics } from '@/lib/changed-lines'

export interface ChatNoteChangeGroup {
  readonly path: string
  readonly title: string
  readonly changeIds: readonly string[]
  readonly beforeSource: string | null
  readonly afterSource: string
  readonly state: 'applied' | 'undone' | 'uncertain'
  readonly addedLines: number
  readonly removedLines: number
}

/** Collapse one turn's operation journal into its first-before/final-after note changes. */
export function groupChatNoteChanges(changes: readonly ChatNoteChange[]): ChatNoteChangeGroup[] {
  const byPath = new Map<string, ChatNoteChange[]>()
  for (const change of changes) {
    if (change.state === 'failed') {
      continue
    }
    const existing = byPath.get(change.path) ?? []
    existing.push(change)
    byPath.set(change.path, existing)
  }

  const groups: ChatNoteChangeGroup[] = []
  for (const [path, pathChanges] of byPath) {
    const ordered = pathChanges.toSorted((left, right) => left.sequence - right.sequence)
    const first = ordered[0]!
    const last = ordered.at(-1)!
    const statistics = changedLineStatistics(first.beforeSource, last.afterSource)
    groups.push({
      path,
      title: parseNote({ path, source: last.afterSource }).title,
      changeIds: ordered.map((change) => change.id),
      beforeSource: first.beforeSource,
      afterSource: last.afterSource,
      state: groupState(ordered),
      ...statistics,
    })
  }

  return groups.sort((left, right) => left.path.localeCompare(right.path))
}

function groupState(changes: readonly ChatNoteChange[]): ChatNoteChangeGroup['state'] {
  if (
    changes.some(
      (change) =>
        change.state === 'prepared' || change.state === 'uncertain' || change.state === 'undoing',
    )
  ) {
    return 'uncertain'
  }
  if (changes.some((change) => change.state === 'applied')) {
    return 'applied'
  }
  return 'undone'
}
