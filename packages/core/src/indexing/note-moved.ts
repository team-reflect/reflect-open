import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge'

/**
 * The Rust-side "note rows moved" broadcast (`note:moved`), emitted after a
 * rename lands (`note_move_indexed`) or an external move is healed by id
 * (`index_move`). The cross-window sibling of the in-process
 * `followHealedMove` hook: a secondary note window with the note open must
 * retarget its session too, or its next save would resurrect the dead file
 * at the old path. The main window drives moves itself and never subscribes.
 */

/** Event name the Rust move commands emit after their rows commit. */
export const NOTE_MOVED_EVENT = 'note:moved'

const noteMovedSchema = z.object({ from: z.string(), to: z.string() })

/** Subscribe to committed note moves (graph-relative `from` → `to` paths). */
export function subscribeNoteMoved(handler: (from: string, to: string) => void): Promise<Unlisten> {
  return getBridge().listen(NOTE_MOVED_EVENT, (payload) => {
    const parsed = noteMovedSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data.from, parsed.data.to)
    } else {
      // Contract drift between Rust and TS must be loud — a silently dropped
      // move leaves an open editor writing to a dead path.
      console.error('invalid note:moved payload:', parsed.error)
    }
  })
}
