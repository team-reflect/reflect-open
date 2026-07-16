import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const workflowPath = join(scriptsDirectory, '..', '..', '..', '.github', 'workflows', 'release.yml')
const workflow = readFileSync(workflowPath, 'utf8')

test('Apple Silicon releases pin the runner and isolate Xcode build caches', () => {
  const appleSiliconMatrix = workflow.match(
    /- name: Apple Silicon\n\s+runner: [^\n]+\n\s+target: aarch64-apple-darwin/,
  )?.[0]
  expect(appleSiliconMatrix).toContain('runner: macos-26')

  const cacheScopeStart = workflow.indexOf('- name: Scope the Rust cache to Xcode')
  const cargoCacheStart = workflow.indexOf('- name: Cache cargo build')
  expect(cacheScopeStart).toBeGreaterThan(-1)
  expect(cargoCacheStart).toBeGreaterThan(cacheScopeStart)

  const cacheScope = workflow.slice(cacheScopeStart, cargoCacheStart)
  expect(cacheScope).toContain('xcrun --find clang')
  expect(cacheScope).toContain('libclang_rt.osx.a')
  expect(cacheScope).toContain('CC=$clang')
  expect(cacheScope).toContain('RUST_CACHE_XCODE=$compiler_hash')
})
