import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const scriptsDirectory = import.meta.dirname
const workflowPath = join(
  scriptsDirectory,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'publish-macos.yml',
)
const workflow = readFileSync(workflowPath, 'utf8')

const setupRust = readFileSync(
  join(scriptsDirectory, '..', '..', '..', '.github', 'actions', 'setup-rust', 'action.yml'),
  'utf8',
)

test('Apple Silicon releases pin the runner', () => {
  const appleSiliconMatrix = workflow.match(
    /- name: Apple Silicon\n\s+runner: [^\n]+\n\s+target: aarch64-apple-darwin/,
  )?.[0]
  expect(appleSiliconMatrix).toContain('runner: macos-26')
})

test('the cargo cache is scoped to Xcode before it is restored', () => {
  const cacheScopeStart = setupRust.indexOf('- name: Scope the cargo cache to Xcode')
  const cargoCacheStart = setupRust.indexOf('- name: Cache cargo build')
  expect(cacheScopeStart).toBeGreaterThan(-1)
  expect(cargoCacheStart).toBeGreaterThan(cacheScopeStart)
  expect(setupRust.slice(cacheScopeStart, cargoCacheStart)).toContain(
    'RUST_CACHE_CLANG_DIR=$(xcrun clang --print-resource-dir)',
  )
})
