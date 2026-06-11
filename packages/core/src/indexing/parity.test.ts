import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { foldKey, parseNote } from '../markdown'
import { hashContent } from './hash'
import { buildIndexedNote } from './indexed-note'
import { buildFtsMatch } from './search-query'

/**
 * The TS side of the TS↔Rust parity contract (see `fixtures/parity/README.md`).
 *
 * The `reflect` CLI (`apps/cli`) re-implements this package's read-side
 * contract in Rust. This test derives `fixtures/parity/expected.json` from the
 * real core pipeline and fails when the committed file drifts; the CLI's
 * `tests/parity.rs` asserts its mirror produces the same values. A behavior
 * change here therefore can't ship without regenerating the expectations
 * (`UPDATE_PARITY=1 pnpm --filter @reflect/core test --run parity`) — and the
 * regenerated file forces the Rust mirror to follow in the same PR.
 */

const corpusDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'parity',
)
const expectedFile = join(corpusDir, 'expected.json')

/** Expectations for one fixture note — the derivations both sides must agree on. */
interface ExpectedNote {
  title: string
  titleKey: string
  aliases: string[]
  aliasKeys: string[]
  private: boolean
  fileHash: string
}

interface ExpectedParity {
  notes: Record<string, ExpectedNote>
  foldKey: Record<string, string>
  ftsMatch: Record<string, string | null>
}

interface ScalarInputs {
  foldKey: string[]
  ftsMatch: string[]
}

/** Graph-relative paths of every fixture `.md`, mirroring the CLI's walk. */
function walkCorpusNotes(): string[] {
  const paths: string[] = []
  for (const dir of ['daily', 'notes']) {
    const stack = [join(corpusDir, dir)]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) {
        break
      }
      for (const entry of readdirSync(current)) {
        const full = join(current, entry)
        if (statSync(full).isDirectory()) {
          stack.push(full)
        } else if (entry.endsWith('.md')) {
          paths.push(full.slice(corpusDir.length + 1).replaceAll('\\', '/'))
        }
      }
    }
  }
  return paths.sort()
}

async function deriveExpectations(): Promise<ExpectedParity> {
  const notes: Record<string, ExpectedNote> = {}
  for (const relPath of walkCorpusNotes()) {
    const source = readFileSync(join(corpusDir, relPath), 'utf8')
    const indexed = buildIndexedNote(parseNote({ path: relPath, source }), {
      fileHash: await hashContent(source),
      mtime: 0,
      source,
    })
    notes[relPath] = {
      title: indexed.title,
      titleKey: indexed.titleKey,
      aliases: indexed.aliases.map((alias) => alias.alias),
      aliasKeys: indexed.aliases.map((alias) => alias.aliasKey),
      private: indexed.isPrivate,
      fileHash: indexed.fileHash,
    }
  }

  const scalars: ScalarInputs = JSON.parse(readFileSync(join(corpusDir, 'scalars.json'), 'utf8'))
  return {
    notes,
    foldKey: Object.fromEntries(scalars.foldKey.map((input) => [input, foldKey(input)])),
    ftsMatch: Object.fromEntries(scalars.ftsMatch.map((input) => [input, buildFtsMatch(input)])),
  }
}

describe('TS↔Rust parity corpus', () => {
  it('expected.json matches what the core pipeline derives', async () => {
    const derived = await deriveExpectations()
    if (process.env.UPDATE_PARITY) {
      writeFileSync(expectedFile, `${JSON.stringify(derived, null, 2)}\n`)
    }
    const committed: ExpectedParity = JSON.parse(readFileSync(expectedFile, 'utf8'))
    expect(committed).toEqual(derived)
  })
})
