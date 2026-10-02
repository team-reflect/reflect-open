import type { MarkdownAstPath } from '@meowdown/markdown'
import { z } from 'zod'

const taskPathSchema = z.array(z.number().int().nonnegative()).min(1).readonly()

/** A task's stored address: its child indexes from the note body's AST root, as a JSON array. */
export function encodeTaskPath(astPath: MarkdownAstPath): string {
  return JSON.stringify(astPath)
}

export function decodeTaskPath(column: string): MarkdownAstPath {
  return taskPathSchema.parse(JSON.parse(column))
}

export function isSameTaskPath(left: MarkdownAstPath, right: MarkdownAstPath): boolean {
  return left.length === right.length && left.every((index, i) => index === right[i])
}

/** Orders paths as the document does: by the first differing index, with an ancestor before its descendants. */
export function compareTaskPaths(left: MarkdownAstPath, right: MarkdownAstPath): number {
  const shared = Math.min(left.length, right.length)
  for (let i = 0; i < shared; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) {
      return delta
    }
  }
  return left.length - right.length
}
