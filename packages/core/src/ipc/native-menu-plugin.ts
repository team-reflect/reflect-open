import { z } from 'zod'
import { definePluginCommand, definePluginEvent, ignoredResult } from './plugin.ts'

/**
 * Typed bindings for `plugins/tauri-plugin-native-menu`, the iPad's native
 * menus: the menu bar (`UIMainMenuSystem`, iPadOS 26+) and context menus at a
 * point (`UIEditMenuInteraction`). Each type mirrors a serde model in the
 * plugin's `src/models.rs` and a `Decodable` struct in
 * `ios/Sources/NativeMenuPlugin.swift`; a field change there must land here in
 * the same review.
 */

/** A `UIKeyModifierFlags` member. */
export type MainMenuModifier = 'command' | 'shift' | 'alternate' | 'control'

/** A key the plugin names rather than spells as a character. */
export type MainMenuNamedKey =
  | 'enter'
  | 'escape'
  | 'tab'
  | 'delete'
  | 'upArrow'
  | 'downArrow'
  | 'leftArrow'
  | 'rightArrow'

/** The key equivalent of a `UIKeyCommand`. */
export interface MainMenuKeyEquivalent {
  /**
   * One character, or a {@link MainMenuNamedKey}. The plugin rejects any
   * other string, so a menu with one fails to install.
   */
  readonly input: string
  readonly modifiers: readonly MainMenuModifier[]
}

export type MainMenuItem =
  | {
      readonly kind: 'command'
      /** Reported back on the `menuCommand` event when the item is chosen. */
      readonly id: string
      readonly title: string
      readonly keyEquivalent?: MainMenuKeyEquivalent
    }
  | { readonly kind: 'separator' }

/**
 * Which of the system's standard menus a section joins; `null` adds a new
 * top-level menu titled by the section.
 */
export type MainMenuPlacement = 'application' | 'file' | 'edit' | 'view' | 'window' | 'help'

export interface MainMenuSection {
  readonly title: string
  readonly placement: MainMenuPlacement | null
  readonly items: readonly MainMenuItem[]
}

export const setMainMenuCommand = definePluginCommand<
  { request: { sections: readonly MainMenuSection[] } },
  unknown
>('native-menu', 'set_menu', ignoredResult)

/** Fires with the item id when the user chooses a command item or presses its key equivalent. */
export const mainMenuCommandEvent = definePluginEvent(
  'native-menu',
  'menuCommand',
  z.object({ id: z.string() }),
)

/** One item of a context menu. */
export interface ContextMenuItem {
  readonly id: string
  readonly title: string
  readonly destructive?: boolean
}

/**
 * Present a context menu at a point of the webview (CSS pixels); resolves with
 * the chosen item's id, or `null` once the menu is dismissed.
 */
export const presentContextMenuCommand = definePluginCommand<
  { request: { items: readonly ContextMenuItem[]; x: number; y: number } },
  { id: string | null }
>('native-menu', 'present_context_menu', z.object({ id: z.string().nullable() }))
