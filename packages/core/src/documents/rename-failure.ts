/**
 * Failure reporting for one settled rename (Plan 07b/17). The three phases
 * fail independently, and the report says what *held*: a failed rewrite with
 * a placed alias still resolves every old link, while a failed alias after a
 * clean rewrite breaks none — only both failing leaves links dangling. A
 * failed move is cosmetic (filename drift; resolution never reads
 * filenames). One combined "failure" string couldn't say any of that.
 */

/** Per-phase failure messages from one rename; `null` means the phase held. */
export interface RenamePhaseFailures {
  rewrite: string | null
  alias: string | null
  move: string | null
}

/**
 * The operation-status message for a settled rename of `from`, or `null`
 * when every phase succeeded. The operation label already names the rename;
 * the message says what failed and what that means for the user's links.
 */
export function composeRenameFailure(from: string, failures: RenamePhaseFailures): string | null {
  const parts: string[] = []
  if (failures.rewrite !== null && failures.alias !== null) {
    parts.push(
      `${failures.rewrite}; the old-title alias also failed (${failures.alias}) — links to "${from}" may no longer resolve`,
    )
  } else if (failures.rewrite !== null) {
    parts.push(
      `${failures.rewrite} — links were not rewritten, but "${from}" was kept as an alias so they still resolve`,
    )
  } else if (failures.alias !== null) {
    parts.push(
      `links were rewritten, but recording "${from}" as an alias failed: ${failures.alias}`,
    )
  }
  if (failures.move !== null) {
    parts.push(`the file keeps its old name (${failures.move})`)
  }
  return parts.length > 0 ? parts.join('; ') : null
}
