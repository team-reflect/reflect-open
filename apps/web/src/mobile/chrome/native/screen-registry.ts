import { isDeepEqual } from '@ocavue/utils'
import { WritableStore, type Unlisten } from '@reflect/core'
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import type { NativeBarButton } from '@/mobile/native-chrome/protocol.ts'

/**
 * The corner buttons of one screen, as the shell draws them.
 */
export interface ScreenBar {
  leading: NativeBarButton[]
  trailing: NativeBarButton[]
}

/**
 * The chrome of every registered screen, keyed by the history entry the
 * screen shows. A screen kept mounted under a stacked card keeps its own
 * entry, so the shell always gets the bar of the entry on screen.
 */
export class ScreenRegistry {
  /**
   * A snapshot of the bar of every registered screen.
   */
  readonly bars = new WritableStore<ReadonlyMap<number, ScreenBar>>(new Map(), isDeepEqual)
  readonly #screens = new Map<number, { readonly current: ScreenChrome }>()

  /**
   * Register `chrome` for `entryId`; returns the unregister, which keeps a
   * registration that another screen made later.
   */
  register(entryId: number, chrome: { readonly current: ScreenChrome }): Unlisten {
    this.#screens.set(entryId, chrome)
    return () => {
      if (this.#screens.get(entryId) !== chrome) {
        return
      }
      this.#screens.delete(entryId)
      this.#updateBars((bars) => {
        bars.delete(entryId)
      })
    }
  }

  /**
   * Take a new snapshot of the bar of `entryId`.
   */
  update(entryId: number): void {
    const chrome = this.#screens.get(entryId)?.current
    if (chrome === undefined) {
      return
    }
    // A copy, so an in-place change of the screen's buttons is a change.
    const bar = structuredClone({ leading: chrome.leading ?? [], trailing: chrome.trailing ?? [] })
    this.#updateBars((bars) => {
      bars.set(entryId, bar)
    })
  }

  /**
   * The chrome registered for `entryId`.
   */
  chrome(entryId: number): ScreenChrome | undefined {
    return this.#screens.get(entryId)?.current
  }

  #updateBars(update: (bars: Map<number, ScreenBar>) => void): void {
    const next = new Map(this.bars.get())
    update(next)
    this.bars.set(next)
  }
}
