import { diffLines } from 'diff'
import { splitFrontmatter } from '@reflect/core'

/** Physical body lines added and removed between two note sources (`null` before = created). */
export function changedLineStatistics(
  beforeSource: string | null,
  afterSource: string,
): { addedLines: number; removedLines: number } {
  const beforeBody = beforeSource === null ? '' : splitFrontmatter(beforeSource).body
  const afterBody = splitFrontmatter(afterSource).body
  let addedLines = 0
  let removedLines = 0
  for (const part of diffLines(beforeBody, afterBody)) {
    if (part.added) {
      addedLines += physicalLineCount(part.value)
    } else if (part.removed) {
      removedLines += physicalLineCount(part.value)
    }
  }
  return { addedLines, removedLines }
}

function physicalLineCount(value: string): number {
  if (value === '') {
    return 0
  }
  const newlineCount = value.match(/\n/g)?.length ?? 0
  return newlineCount + (value.endsWith('\n') ? 0 : 1)
}
