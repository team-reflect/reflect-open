/**
 * Ephemeral authority for one lazily-created New Note route.
 *
 * A ULID-shaped path is not authority by itself: an adopted note can already
 * have that filename, and a deleted note can remain in browser history. Only
 * the explicit New Note commands grant a claim. The owning document session
 * consumes it when an existing file wins, its first create is dispatched, or
 * the session retargets, so a later pane mount can never recreate that path.
 * Root + open generation scope every claim; graph switches and reopens cannot
 * carry creation authority into another filesystem session.
 */

export interface NewNoteCreationScope {
  /** Absolute graph root. */
  readonly root: string
  /** File-session generation, bumped on every graph open. */
  readonly generation: number
}

const claims = new Set<string>()

function claimKey(scope: NewNoteCreationScope, path: string): string {
  return JSON.stringify([scope.root, scope.generation, path])
}

/** Grant one fresh route permission to claim its absent path. */
export function grantNewNoteCreation(scope: NewNoteCreationScope, path: string): void {
  claims.add(claimKey(scope, path))
}

/** Whether a newly-mounted pane may adopt this route's outstanding claim. */
export function hasNewNoteCreationClaim(scope: NewNoteCreationScope, path: string): boolean {
  return claims.has(claimKey(scope, path))
}

/** Permanently consume a route's claim. Safe to call more than once. */
export function consumeNewNoteCreationClaim(scope: NewNoteCreationScope, path: string): void {
  claims.delete(claimKey(scope, path))
}
