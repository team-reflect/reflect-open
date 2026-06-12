/**
 * Native menu → command registry hand-off. The menu is built once at startup,
 * before React mounts, so item activations land here and are forwarded to
 * whichever mounted workspace currently owns the {@link import('@/lib/commands/types').CommandContext}.
 *
 * `useAppShortcuts` publishes its dispatcher on mount and clears it on
 * unmount. While no dispatcher is set (the moments before first mount, or
 * screens without a workspace) menu items are inert — there is nothing for a
 * command to act on, which is the same answer the keydown path gives there.
 */

type MenuCommandDispatch = (commandId: string) => void

let current: MenuCommandDispatch | null = null

/** Publish (or with `null`, withdraw) the active menu-command dispatcher. */
export function setMenuCommandDispatch(dispatch: MenuCommandDispatch | null): void {
  current = dispatch
}

/** Forward a native menu activation to the active dispatcher, if any. */
export function dispatchMenuCommand(commandId: string): void {
  current?.(commandId)
}
