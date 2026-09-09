import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/**
 * The X watcher runs on every x.com page once the feature is on, so its
 * bundle must stay small: no zod, no schema construction. This walks the
 * script's value-level import graph from source (the built bundle is not
 * available to unit tests) and fails on the first edge into a validator
 * module. `import type` edges are erased by the bundler and are skipped.
 */

const EXTENSION_ROOT = resolve(import.meta.dirname, '../..')
const CORE_ROOT = resolve(EXTENSION_ROOT, '../../packages/core')
const ENTRY = resolve(EXTENSION_ROOT, 'entrypoints/x-bookmarks.content.ts')

/** Modules the watcher must never reach at value level. */
const FORBIDDEN = new Set([
  'zod',
  '@reflect/core/capture-envelope',
  'apps/extension/lib/x/messages.ts',
])

/** Bare specifiers that are part of the runtime, not the bundle. */
const EXTERNAL = new Set(['wxt/browser', '#imports'])

/** Every `import … '…'` statement head; group 1 is the specifier. */
const IMPORT_RE = /^import [^'"]*['"]([^'"]+)['"]/gm

/** `import type …` is erased by the bundler and adds no edge. */
function isTypeOnly(statement: string): boolean {
  return statement.startsWith('import type ')
}

const corePackageSchema = z.object({ exports: z.record(z.string(), z.string()) })

function coreSubpath(specifier: string): string | null {
  const packageJson = corePackageSchema.parse(
    JSON.parse(readFileSync(resolve(CORE_ROOT, 'package.json'), 'utf8')),
  )
  const relative = packageJson.exports[`.${specifier.slice('@reflect/core'.length)}`]
  return relative === undefined ? null : resolve(CORE_ROOT, relative)
}

function resolveSpecifier(specifier: string, from: string): string | null {
  if (EXTERNAL.has(specifier)) {
    return null
  }
  if (specifier.startsWith('@reflect/core')) {
    const target = coreSubpath(specifier)
    if (target === null) {
      throw new Error(`${from} imports ${specifier}, which the core package does not export`)
    }
    return target
  }
  if (specifier.startsWith('@/')) {
    return resolve(EXTENSION_ROOT, `${specifier.slice(2)}.ts`)
  }
  if (specifier.startsWith('.')) {
    return resolve(dirname(from), `${specifier}.ts`)
  }
  return specifier
}

/** Every value-level import edge reachable from `entry`, as `[importer, specifier]`. */
function valueImportEdges(entry: string): Array<[string, string]> {
  const edges: Array<[string, string]> = []
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_RE)) {
      const [statement, specifier] = match
      if (isTypeOnly(statement) || specifier === undefined) {
        continue
      }
      edges.push([file, specifier])
      const target = resolveSpecifier(specifier, file)
      if (target !== null && target.endsWith('.ts')) {
        queue.push(target)
      }
    }
  }
  return edges
}

describe('x-bookmarks content script bundle', () => {
  it('reaches no validator module at value level', () => {
    const offending = valueImportEdges(ENTRY).filter(([importer, specifier]) => {
      const target = resolveSpecifier(specifier, importer)
      const asRepoPath = target?.replace(/^.*?\/(apps|packages)\//, '$1/')
      return FORBIDDEN.has(specifier) || (asRepoPath !== undefined && FORBIDDEN.has(asRepoPath))
    })
    expect(
      offending.map(
        ([importer, specifier]) =>
          `${importer.replace(EXTENSION_ROOT, 'apps/extension')} → ${specifier}`,
      ),
    ).toEqual([])
  })
})
