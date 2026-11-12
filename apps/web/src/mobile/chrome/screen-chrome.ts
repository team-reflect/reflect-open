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

/**
 * A confirmation shown before a menu item runs, with one destructive button
 * and Cancel.
 */
export interface ChromeConfirm {
  title: string
  message?: string | undefined
  /**
   * The label of the destructive button.
   */
  action: string
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
      confirm?: ChromeConfirm | undefined
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
 * The corners of one screen's top bar.
 */
export interface ScreenChrome {
  /**
   * Pops the screen. The bar shows a back button only with it.
   */
  back?: (() => void) | undefined
  leading?: ChromeButton[] | undefined
  trailing?: ChromeButton[] | undefined
  /**
   * Runs a button or a menu item by id.
   */
  onAction?: ((id: string) => void) | undefined
}
