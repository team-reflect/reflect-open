import { expect, it } from 'vitest'
import { anySignal } from '@/lib/any-signal.ts'

/**
 * Allocates until the garbage collector has run a few times and has freed an
 * unreferenced object. Throws if it never does.
 */
async function collectGarbage(): Promise<void> {
  const probe = new WeakRef({})
  for (let round = 0; round < 30 || probe.deref(); round++) {
    if (round === 60) {
      throw new Error('The garbage collector did not run')
    }
    // A new task: `deref()` keeps the probe alive until the current one ends.
    await new Promise((resolve) => setTimeout(resolve, 100))
    let junk: object[] | undefined = []
    for (let i = 0; i < 200_000; i++) {
      junk.push({ i })
    }
    junk = undefined
  }
}

it('removes listeners after a garbage collection', async () => {
  const target = new EventTarget()
  const sources = Array.from({ length: 200 }, () => new AbortController())
  let calls = 0
  for (const source of sources) {
    const signal = anySignal([new AbortController().signal, source.signal])
    target.addEventListener('probe', () => calls++, { signal })
  }
  await collectGarbage()
  for (const source of sources) {
    source.abort()
  }
  target.dispatchEvent(new Event('probe'))
  expect(calls).toBe(0)
})
