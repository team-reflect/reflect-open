import type { GraphImportProgress, GraphImportSummary } from '@reflect/core'

/**
 * Where the Reflect V1 import stands. `running.progress` is null until the
 * first native progress tick (the zip is being read); `cancelling` means the
 * user asked to stop and the native side is winding down.
 */
export type V1ImportState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: GraphImportProgress | null; cancelling: boolean }
  | { phase: 'done'; summary: GraphImportSummary }
  | { phase: 'failed'; message: string }
