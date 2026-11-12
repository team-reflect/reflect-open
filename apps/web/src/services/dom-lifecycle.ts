import type { LifecycleDomAdapter } from '@reflect/app'
import type { Unlisten } from '@reflect/core'

export interface DomLifecycleAdapterDeps {
  readonly window: Window
  readonly document: Document
}

class DomLifecycleAdapterImpl implements LifecycleDomAdapter {
  readonly #deps: DomLifecycleAdapterDeps

  constructor(deps: DomLifecycleAdapterDeps) {
    this.#deps = deps
  }

  onPageEvent(
    type: Parameters<LifecycleDomAdapter['onPageEvent']>[0],
    listener: () => void,
  ): Unlisten {
    const target = this.#deps.window
    target.addEventListener(type, listener)
    return () => {
      target.removeEventListener(type, listener)
    }
  }

  onVisibilityChange(listener: () => void): Unlisten {
    const target = this.#deps.document
    target.addEventListener('visibilitychange', listener)
    return () => {
      target.removeEventListener('visibilitychange', listener)
    }
  }

  isHidden(): boolean {
    return this.#deps.document.visibilityState === 'hidden'
  }
}

/**
 * Lifecycle signals from a page's `window` and `document`.
 */
export function createDomLifecycleAdapter(
  deps: DomLifecycleAdapterDeps = { window, document },
): LifecycleDomAdapter {
  return new DomLifecycleAdapterImpl(deps)
}
