import type { MaybePromise } from '@reflect/utils'
/**
 * The system clipboard.
 */
export interface ClipboardService {
  writeText(text: string): MaybePromise<void>
}
