import type { Store, Unlisten } from '@reflect/core'

/**
 * The button on a toast.
 */
export interface ToastAction {
  readonly label: string
  readonly run: () => void
}

/**
 * One toast, as the UI should show it.
 *
 * The shape copies Base UI's toast options without the React types:
 * `ToastObject` and `ToastManagerAddOptions` in
 * https://github.com/mui/base-ui/blob/v1.9.0/packages/react/src/toast/useToastManager.ts#L26-L133.
 * `action` stands in for `actionProps`, and `dismissible` for the `data` flag
 * that the desktop toast reads.
 */
export interface ToastSpec {
  /**
   * Showing a spec with the id of an open toast replaces that toast.
   */
  readonly id?: string | undefined
  readonly title: string
  readonly description?: string | undefined
  readonly type?: 'loading' | 'success' | 'error' | 'warning' | undefined
  /**
   * Milliseconds before the toast closes itself; `0` keeps it open. Left out,
   * the toast surface's default applies.
   */
  readonly timeout?: number | undefined
  /**
   * `false` hides the close button and turns off swipe-to-dismiss.
   */
  readonly dismissible?: boolean | undefined
  readonly action?: ToastAction | undefined
  /**
   * Runs on every close: the timeout, the user, or {@link ToastService.close}.
   */
  readonly onClose?: (() => void) | undefined
}

/**
 * A {@link ToastSpec} with an id, as {@link syncToasts} needs.
 */
export type KeyedToastSpec = ToastSpec & { readonly id: string }

/**
 * The toast surface.
 */
export interface ToastService {
  show(spec: ToastSpec): void
  close(id: string): void
}

/**
 * Shows the toasts in `specs` and keeps them in step with it: a spec that
 * leaves the list closes its toast. Returns the function that stops following
 * `specs`; it leaves the open toasts open.
 */
export function syncToasts(
  specs: Store<readonly KeyedToastSpec[]>,
  toasts: ToastService,
): Unlisten {
  let shownIds = new Set<string>()
  const sync = (): void => {
    const current = specs.get()
    const nextIds = new Set(current.map((spec) => spec.id))
    for (const id of shownIds) {
      if (!nextIds.has(id)) {
        toasts.close(id)
      }
    }
    for (const spec of current) {
      toasts.show(spec)
    }
    shownIds = nextIds
  }
  sync()
  return specs.subscribe(sync)
}
