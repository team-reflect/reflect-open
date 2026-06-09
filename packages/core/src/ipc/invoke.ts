import { invoke } from '@tauri-apps/api/core'
import type { ZodType } from 'zod'

/**
 * The single boundary where an untyped Tauri IPC response becomes a typed,
 * validated domain value.
 *
 * Components and hooks must never call `invoke` from `@tauri-apps/api`
 * directly — they call a typed binding (see `commands.ts`) that funnels through
 * here. Every response is validated with a zod schema; Rust is responsible for
 * emitting camelCase keys so the parsed value needs no further normalization.
 *
 * @param command  The `#[tauri::command]` name (snake_case).
 * @param args     Arguments passed to the command.
 * @param schema   Zod schema the response must satisfy.
 * @returns        The validated, typed result.
 */
export async function call<TOutput>(
  command: string,
  args: Record<string, unknown>,
  schema: ZodType<TOutput>,
): Promise<TOutput> {
  const raw = await invoke(command, args)
  return schema.parse(raw)
}
