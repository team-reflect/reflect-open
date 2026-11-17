import type { MenuConfirm } from '@reflect/types'
import type { RefObject } from 'react'
import type { AudioMemoPhase } from '@reflect/core'
import type { MaybePromise } from '@reflect/utils'

/**
 * An icon that every chrome renderer can draw.
 */
export type ChromeIcon =
  | 'settings'
  | 'plus'
  | 'history'
  | 'ellipsis'
  | 'pin'
  | 'pin-off'
  | 'lock'
  | 'lock-open'
  | 'share'
  | 'trash'
  | 'chat'
  | 'chat-active'
  | 'archive'
  | 'filters'

/**
 * Something a screen can focus: an input, or the shell's search field.
 */
export interface Focusable {
  focus(): void
  /**
   * Selects the text. The shell's search field selects it on focus.
   */
  select?(): void
}

/**
 * The middle of a top bar: a heading, or a heading that picks a month.
 */
export type ChromeTitle =
  | string
  | {
      kind: 'month'
      /**
       * The month the title shows, `YYYY-MM`.
       */
      month: string
      /**
       * The selected day's month, `YYYY-MM`.
       */
      selected: string
      /**
       * Today's month, `YYYY-MM`.
       */
      today: string
      onPick: (month: string) => void
    }

/**
 * The search field of a top bar.
 */
export interface ChromeSearch {
  value: string
  placeholder: string
  /**
   * The accessibility label.
   */
  label: string
  onChange: (value: string) => void
  /**
   * Receives the field, so an arrival can focus it.
   */
  ref?: RefObject<Focusable | null> | undefined
}

/**
 * One row of a corner button's menu, in the order the menu shows it.
 */
export type ChromeMenuItem =
  | {
      type: 'action'
      id: string
      title: string
      icon?: ChromeIcon | undefined
      destructive?: boolean | undefined
      disabled?: boolean | undefined
      /**
       * Shows a checkmark.
       */
      checked?: boolean | undefined
      confirm?: MenuConfirm | undefined
    }
  | {
      type: 'section'
      title?: string | undefined
      items: ChromeMenuItem[]
    }

/**
 * A button in a corner of a top bar. A tap opens `menu` when it has one, and
 * runs the action `id` otherwise.
 */
export interface ChromeButton {
  id: string
  /**
   * The label, also the accessibility label of an icon button.
   */
  title: string
  /**
   * Without an icon the button shows `title`.
   */
  icon?: ChromeIcon | undefined
  menu?: ChromeMenuItem[] | undefined
  /**
   * The button keeps its place but does not show.
   */
  hidden?: boolean | undefined
}

/**
 * The top bar of one screen: its corners, title and search field.
 */
export interface ScreenChrome {
  /**
   * Pops the screen. The bar shows a back button only with it.
   */
  back?: (() => void) | undefined
  /**
   * The screen shows no tab bar. The iPad sidebar and top tab bar stay.
   */
  hidesTabBar?: boolean | undefined
  leading?: ChromeButton[] | undefined
  trailing?: ChromeButton[] | undefined
  /**
   * Runs a button or a menu item by id. The renderer shows a rejection to
   * the user; its message is the text the user reads.
   */
  onAction?: ((id: string) => MaybePromise<void>) | undefined
  /**
   * The screen's `+`.
   */
  plus?: ChromePlus | undefined
  /**
   * The middle of the bar, when it has no search field.
   */
  title?: ChromeTitle | undefined
  search?: ChromeSearch | undefined
}

/**
 * The `+` of a screen: Daily's capture actions, or one action.
 */
export type ChromePlus =
  | {
      kind: 'capture'
      /**
       * The audio memo phase, or `null` where the recorder is unavailable.
       */
      audio: AudioMemoPhase | null
      onNote: () => void
      onTask: () => void
      onAudio: () => void
    }
  | {
      kind: 'action'
      /**
       * The accessibility label.
       */
      label: string
      onTap: () => void
    }
