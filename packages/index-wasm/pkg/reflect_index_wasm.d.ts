// The types of the bindings that `pnpm build:index-wasm` writes next to this
// file, for `crates/index-wasm/src/lib.rs`.

/**
 * One index session over an in-memory database.
 */
export class WasmIndex {
  constructor()
  /**
   * Runs `command` with JSON text of its arguments; the reply is JSON text.
   * Throws JSON text of the error, `{ kind, message }`.
   */
  call(command: string, argsJson: string): string
  /**
   * Runs `note_move_indexed`; `rename` moves the file.
   */
  move_note(argsJson: string, rename: () => void): void
  /**
   * Takes the events of the committed writes since the last call, as JSON
   * text: an array of `{ event, payload }`.
   */
  take_events(): string
  /**
   * Releases the database.
   */
  free(): void
}

/**
 * Every command that a `WasmIndex` answers.
 */
export function index_commands(): string[]

/**
 * Loads the wasm module. Call it once, before any other export.
 */
export default function init(options: {
  module_or_path: URL | BufferSource | WebAssembly.Module
}): Promise<unknown>
