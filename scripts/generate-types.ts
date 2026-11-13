// Generates `@reflect/types` and the `TypesShared` Swift module from the wire
// types in `crates/types`, then formats the Swift file with `swift format`
// (macOS only).
//
//   pnpm gen:types

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dirname, '..')
const SWIFT_PATH = join(ROOT_DIR, 'apple', 'Sources', 'TypesShared', 'Wire.gen.swift')

execFileSync(
  'cargo',
  ['run', '--quiet', '--package', 'reflect-types', '--features', 'codegen', '--bin', 'codegen'],
  { cwd: ROOT_DIR, stdio: 'inherit' },
)
execFileSync('swift', ['format', 'format', '--in-place', SWIFT_PATH], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
})
