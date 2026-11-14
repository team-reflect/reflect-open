import type { GraphImportProgress } from '@reflect/types'
import { z } from 'zod'

export type {
  FileMeta,
  GraphImportProgress,
  GraphImportSummary,
  GraphInfo,
  NoteCreateOutcome,
  RecentGraph,
  WindowBootstrap,
} from '@reflect/types'

/** One `import:progress` tick from the running Reflect V1 import. */
export const graphImportProgressSchema: z.ZodType<GraphImportProgress> = z.object({
  /** Long remote downloads first, then fast local writes. */
  stage: z.enum(['downloading', 'writing']),
  /** Items finished within the stage. */
  done: z.number(),
  /** Items the stage will process in total. */
  total: z.number(),
})
