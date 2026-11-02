import { expect, it } from 'vitest'

/**
 * Allocates enough to run the garbage collector a few times.
 */
async function collectGarbage(): Promise<void> {
  for (let round = 0; round < 30; round++) {
    let junk: object[] | undefined = []
    for (let i = 0; i < 200_000; i++) {
      junk.push({ i })
    }
    junk = undefined
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const RUNS = Array.from({ length: 20 }, (_, index) => index + 1)

it.for(RUNS)('removes listeners after a garbage collection (run %i)', async () => {
  const target = new EventTarget()
  const sources = Array.from({ length: 200 }, () => new AbortController())
  let calls = 0
  for (const source of sources) {
    const signal = AbortSignal.any([new AbortController().signal, source.signal])
    target.addEventListener('probe', () => calls++, { signal })
  }
  await collectGarbage()
  for (const source of sources) {
    source.abort()
  }
  target.dispatchEvent(new Event('probe'))
  expect(calls).toBe(0)
})
