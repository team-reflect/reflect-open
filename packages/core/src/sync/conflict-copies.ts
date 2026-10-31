/**
 * The product sentence that tells the user which conflict copies a sync kept.
 * Paths are graph-relative and listed in full, so the user can find each copy.
 */
export function describeConflictCopies(paths: readonly string[]): string {
  return paths.length === 1
    ? `Kept a conflict copy: ${paths[0]}`
    : `Kept ${paths.length} conflict copies: ${paths.join(', ')}`
}
