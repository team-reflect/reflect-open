import type { PaletteSections as CorePaletteSections } from '@reflect/app'
import type { AppCommand } from '@/lib/commands/types.ts'

/**
 * The palette's sections, with this app's commands.
 */
export type PaletteSections = CorePaletteSections<AppCommand>
