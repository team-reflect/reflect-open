import type { NativeBarButton } from '@/mobile/native-chrome/protocol.ts'

/**
 * The corners of one screen's top bar.
 */
export interface ScreenChrome {
  /**
   * Pops the screen.
   */
  back?: (() => void) | undefined
  leading?: NativeBarButton[] | undefined
  trailing?: NativeBarButton[] | undefined
  /**
   * Runs a button or a menu item by id.
   */
  onAction?: ((id: string) => void) | undefined
}
