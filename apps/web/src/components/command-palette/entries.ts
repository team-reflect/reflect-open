import type { Command, PaletteSections as CorePaletteSections } from '@reflect/app'

/**
 * The palette's sections, with this app's commands.
 */
export type PaletteSections = CorePaletteSections<Command>
