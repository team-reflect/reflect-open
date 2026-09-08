import type { QueryClient } from '@tanstack/react-query'

/** Captured graph and cache context for a note action. */
export interface NoteActionInput {
  queryClient: QueryClient
  root: string
  generation: number
  path: string
}
