import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { samples } from './wire.samples.gen.ts'

// `tsc` checks each sample against the generated types. This test checks
// that the samples equal the JSON that serde writes.
describe('wire samples', () => {
  for (const [name, values] of Object.entries(samples)) {
    it(`match fixtures/wire/${name}.json`, () => {
      const url = new URL(`../../../fixtures/wire/${name}.json`, import.meta.url)
      expect(values).toEqual(JSON.parse(readFileSync(url, 'utf8')))
    })
  }
})
