import { isApplePlatform } from '@/lib/keybindings.ts'

/** Event modifier fields for the platform's `Mod` key: ⌘ on Apple, Ctrl elsewhere. */
export const MOD_KEY: { metaKey: boolean; ctrlKey: boolean } = isApplePlatform()
  ? { metaKey: true, ctrlKey: false }
  : { metaKey: false, ctrlKey: true }

/** The other command key (Ctrl on Apple, ⌘/Win elsewhere), which is not `Mod`. */
export const NON_MOD_KEY: { metaKey: boolean; ctrlKey: boolean } = {
  metaKey: MOD_KEY.ctrlKey,
  ctrlKey: MOD_KEY.metaKey,
}
