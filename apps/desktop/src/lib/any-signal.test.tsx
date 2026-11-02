import { expect, it } from 'vitest'
import { anySignal } from '@/lib/any-signal.ts'
import { collectGarbage } from '@/test-utils/gc.ts'

const RUNS = Array.from({ length: 20 }, (_, index) => index + 1)

it.for(RUNS)('removes listeners after a garbage collection (run %i)', async () => {
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
