import { describe, expect, it } from 'vitest'
import type { FileChange } from './file-changes'
import { emitIndexApplied, subscribeIndexApplied } from './index-applied'

const batch: FileChange[] = [{ path: 'assets/a.png', kind: 'upsert', modifiedMs: 1 }]

describe('subscribeIndexApplied', () => {
  it('delivers emitted batches (with generation) to every subscriber until it unsubscribes', () => {
    const a: Array<{ paths: string[]; generation: number }> = []
    const b: number[] = []
    const unsubA = subscribeIndexApplied((changes, generation) =>
      a.push({ paths: changes.map((change) => change.path), generation }),
    )
    const unsubB = subscribeIndexApplied((_changes, generation) => b.push(generation))

    emitIndexApplied(batch, 7)
    expect(a).toEqual([{ paths: ['assets/a.png'], generation: 7 }])
    expect(b).toEqual([7])

    unsubA()
    emitIndexApplied(batch, 8)
    expect(a).toHaveLength(1) // no longer delivered
    expect(b).toEqual([7, 8])

    unsubB()
  })

  it('tolerates a listener unsubscribing during emit', () => {
    const seen: number[] = []
    const unsub = subscribeIndexApplied(() => {
      seen.push(1)
      unsub() // remove self mid-emit
    })
    expect(() => emitIndexApplied(batch, 1)).not.toThrow()
    emitIndexApplied(batch, 1)
    expect(seen).toEqual([1]) // fired once, then gone
  })
})
