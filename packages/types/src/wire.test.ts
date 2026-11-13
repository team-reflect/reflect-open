import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { AppErrorSchema, ChangeKindSchema, FileChangeSchema, FileMetaSchema } from './wire.gen.ts'

const schemas: Record<string, ZodType> = {
  AppError: AppErrorSchema,
  ChangeKind: ChangeKindSchema,
  FileChange: FileChangeSchema,
  FileMeta: FileMetaSchema,
}

describe('wire fixtures', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    it(`parses every ${name} sample`, () => {
      const url = new URL(`../../../fixtures/wire/${name}.json`, import.meta.url)
      const samples = JSON.parse(readFileSync(url, 'utf8')) as unknown[]
      expect(samples.length).toBeGreaterThan(0)
      for (const sample of samples) {
        expect(schema.parse(sample)).toEqual(sample)
      }
    })
  }
})
