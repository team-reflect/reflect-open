import type { FileMeta } from '@reflect/types'

import init, { index_commands, WasmIndex } from '../pkg/reflect_index_wasm.js'

const wasmUrl = new URL('../pkg/reflect_index_wasm_bg.wasm', import.meta.url)
if (wasmUrl.protocol === 'file:') {
  const { readFile } = process.getBuiltinModule('node:fs/promises')
  await init({ module_or_path: await readFile(wasmUrl) })
} else {
  await init({ module_or_path: wasmUrl })
}

const COMMANDS: ReadonlySet<string> = new Set(index_commands())

/**
 * The note files of the graph that an index belongs to.
 */
export interface WasmIndexFiles {
  /**
   * Every note file.
   */
  list(): FileMeta[]
  /**
   * Move the note file at `from` to `to`; throw when the move fails.
   */
  move(from: string, to: string): void
}

/**
 * The graph index of the native shells, compiled to wasm, over an in-memory
 * database.
 */
export interface WasmIndexBackend {
  /**
   * Whether `invoke` answers `command`.
   */
  has(command: string): boolean
  /**
   * Run one index command with the arguments of the native command; throws a
   * {@link WasmIndexError}.
   */
  invoke(command: string, args: Record<string, unknown>): unknown
  /**
   * Release the database; later calls throw.
   */
  close(): void
}

/**
 * An error of an index command, with the `kind` of the native `AppError`.
 */
export class WasmIndexError extends Error {
  readonly kind: string

  constructor(kind: string, message: string) {
    super(message)
    this.name = 'WasmIndexError'
    this.kind = kind
  }
}

function toError(thrown: unknown): WasmIndexError {
  if (thrown instanceof WasmIndexError) {
    return thrown
  }
  if (typeof thrown !== 'string') {
    return new WasmIndexError('io', thrown instanceof Error ? thrown.message : String(thrown))
  }
  try {
    const { kind, message } = JSON.parse(thrown) as { kind?: unknown; message?: unknown }
    if (typeof kind === 'string') {
      return new WasmIndexError(kind, typeof message === 'string' ? message : kind)
    }
  } catch {
    // Not JSON: a panic message.
  }
  return new WasmIndexError('unknown', thrown)
}

class WasmIndexBackendImpl implements WasmIndexBackend {
  readonly #files: WasmIndexFiles | undefined
  #index: WasmIndex | null = new WasmIndex()

  constructor(files: WasmIndexFiles | undefined) {
    this.#files = files
  }

  has(command: string): boolean {
    return COMMANDS.has(command)
  }

  invoke(command: string, args: Record<string, unknown>): unknown {
    const index = this.#index
    if (index === null) {
      throw new WasmIndexError('io', 'the index is closed')
    }
    try {
      if (command === 'note_move_indexed') {
        const { from, to } = args['request'] as { from: string; to: string }
        const files = this.#files
        index.move_note(JSON.stringify(args), () => {
          if (files === undefined) {
            throw new Error('the index has no note files to move')
          }
          files.move(from, to)
        })
        return null
      }
      if (command === 'index_reconcile_scan') {
        const files = this.#files?.list() ?? []
        return JSON.parse(
          index.call(command, JSON.stringify({ ...args, files, nowMs: Date.now() })),
        )
      }
      return JSON.parse(index.call(command, JSON.stringify(args)))
    } catch (error) {
      throw toError(error)
    }
  }

  close(): void {
    this.#index?.free()
    this.#index = null
  }
}

/**
 * Create an index over a new in-memory database. `files` backs the two
 * commands that read or move note files; without it the graph lists no files
 * and a note move fails.
 */
export function createWasmIndexBackend(files?: WasmIndexFiles): WasmIndexBackend {
  return new WasmIndexBackendImpl(files)
}
