import type { AppError } from '../errors.ts'

/**
 * Why a reconcile pass ended with memos still pending. `config` = no capable
 * provider/key (self-heals when settings change); `stale` = the caller's
 * abort gate fired; `oversize` = a segment tripped the transcription size
 * guard (should never happen with rotation-sized segments — surfaced loudly,
 * never tombstoned); anything else is the failing step's error kind
 * (`network` while offline is the expected, silent case).
 */
export interface ReconcileStop {
  reason: 'config' | 'stale' | 'oversize' | AppError['kind']
  message: string
}

/**
 * Whether a {@link ReconcileStop} is an expected, self-healing stop that a
 * background controller should swallow rather than surface to the user:
 * `network` (offline — retries on the next trigger), `config` (no provider/key
 * yet — the work waits), or `stale` (a graph switch tore the pass down). Any
 * other reason is an unexpected failure worth surfacing or logging. Shared by
 * every background reconcile loop (capture, transcription, asset descriptions).
 */
export function isSilentStop(stopped: ReconcileStop): boolean {
  return stopped.reason === 'network' || stopped.reason === 'config' || stopped.reason === 'stale'
}
