/**
 * Flow 5c — context sidebar: useSimilarNotes result reference stability.
 *
 * The hook returned `(data ?? []).slice(0, 6)` — a fresh array every render
 * even when the query result was reference-stable, defeating memoization in
 * every consumer that takes it as a dependency. `useMemo` makes the result
 * reference-stable. This bench renders a probe that calls the hook and records
 * the returned array reference each render, then forces parent re-renders and
 * counts the number of DISTINCT references the hook hands out.
 */

import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { RetrievalHit } from '@reflect/core'
import { buildDataset } from './lib/dataset'
import { record } from './lib/record'

const dataset = buildDataset()
const RERENDERS = 20
const similarHits = [...dataset.similarHits]

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { semanticSearchEnabled: true }, updateSettings: () => {} }),
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: similarHits }),
}))

const { useSimilarNotes } = await import('@/lib/use-similar-notes')

describe('useSimilarNotes reference stability', () => {
  it('counts distinct result references across re-renders', async () => {
    const references = new Set<readonly RetrievalHit[]>()
    function Probe(): ReactElement {
      const [tick, setTick] = useState(0)
      const similar = useSimilarNotes('notes/example.md')
      references.add(similar)
      return (
        <button type="button" data-tick={tick} onClick={() => setTick((value) => value + 1)}>
          rerender
        </button>
      )
    }

    const view = render(<Probe />)
    const button = view.getByRole('button', { name: 'rerender' })
    for (let index = 0; index < RERENDERS; index += 1) {
      await userEvent.click(button)
    }
    const distinctReferences = references.size
    view.unmount()

    record({
      flow: 'flow-5c-similar-notes-stability',
      description:
        `Distinct useSimilarNotes result references across ${RERENDERS} re-renders ` +
        `with a reference-stable query result.`,
      metrics: {
        rerenders: RERENDERS,
        totalRenders: RERENDERS + 1,
        distinctResultReferences: distinctReferences,
      },
    })
    expect(distinctReferences).toBeGreaterThanOrEqual(1)
  })
})
