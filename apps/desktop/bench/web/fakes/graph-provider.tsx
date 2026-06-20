import type { ReactElement, ReactNode } from 'react'

/** Static graph — no index session, no IPC. Browser-harness only. */
export function useGraph(): { graph: { root: string; name: string; cloudSync: null; generation: number }; indexing: boolean } {
  return { graph: { root: '/bench-graph', name: 'bench', cloudSync: null, generation: 1 }, indexing: false }
}

export function GraphProvider({ children }: { children: ReactNode }): ReactElement {
  return <>{children}</>
}
