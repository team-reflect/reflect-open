import { toast } from '@/components/ui/toast'
import type { UpdateController, UpdateState } from '@/lib/update-controller'

const UPDATE_TOAST_ID = 'reflect-update'
// `timeout: 0` disables Base UI's auto-dismiss; the dismissible flag hides the
// close button and disables swipe-to-dismiss (see `ToastData` in
// `ui/toast.tsx`).
const NON_DISMISSIBLE_UPDATE_OPTIONS = {
  timeout: 0,
  data: { dismissible: false },
}

function runToastAction(action: () => Promise<void>): void {
  void action().catch((error: unknown) => {
    console.error('update toast action failed:', error)
  })
}

function showUpdateToast(state: UpdateState, controller: UpdateController): void {
  switch (state.phase) {
    case 'available':
      toast.add({
        id: UPDATE_TOAST_ID,
        title: 'Update available',
        description: `Reflect ${state.version} is ready to install.`,
        // `add()` with an existing id merges into the current toast, so this
        // phase clears any stale type (e.g. a lingering spinner) explicitly.
        type: undefined,
        ...NON_DISMISSIBLE_UPDATE_OPTIONS,
        actionProps: {
          children: 'Install',
          onClick: () => runToastAction(controller.install),
        },
      })
      break
    case 'downloading':
      toast.add({
        id: UPDATE_TOAST_ID,
        title: 'Downloading update',
        description: state.percent !== null ? `${state.percent}%` : 'Preparing…',
        type: 'loading',
        // Same merge semantics: without this the "Install" action from the
        // `available` phase would linger as a clickable control over the
        // download progress. The update only becomes installable once it has
        // fully downloaded, surfaced as "Restart" in the `ready` phase.
        actionProps: undefined,
        ...NON_DISMISSIBLE_UPDATE_OPTIONS,
      })
      break
    case 'ready':
      toast.add({
        id: UPDATE_TOAST_ID,
        title: 'Update ready',
        description: `Reflect ${state.version} will finish updating after restart.`,
        type: 'success',
        ...NON_DISMISSIBLE_UPDATE_OPTIONS,
        actionProps: {
          children: 'Restart',
          onClick: () => runToastAction(controller.restart),
        },
      })
      break
    case 'error':
      if (state.during === 'install') {
        toast.add({
          id: UPDATE_TOAST_ID,
          title: 'Update failed',
          description: state.message,
          type: 'error',
          ...NON_DISMISSIBLE_UPDATE_OPTIONS,
          actionProps: {
            children: 'Retry install',
            onClick: () => runToastAction(controller.install),
          },
        })
      } else {
        toast.close(UPDATE_TOAST_ID)
      }
      break
    default:
      toast.close(UPDATE_TOAST_ID)
      break
  }
}

/**
 * Mirrors the auto-update lifecycle into the global toast surface (Plan 15).
 * A plain controller subscriber: the toast calls run inside the controller's
 * own transitions (check results, download progress callbacks), not in a React
 * render cycle. Returns a detach.
 */
export function attachUpdateToasts(controller: UpdateController): () => void {
  const sync = (): void => showUpdateToast(controller.getState(), controller)
  sync()
  return controller.subscribe(sync)
}
