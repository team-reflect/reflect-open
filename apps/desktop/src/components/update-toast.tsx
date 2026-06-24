import { useEffect, type ReactElement } from 'react'
import { toast } from 'sonner'
import { useUpdate } from '@/providers/update-provider'

const UPDATE_TOAST_ID = 'reflect-update'
const PERSISTENT_TOAST_MS = Number.POSITIVE_INFINITY
const NON_DISMISSIBLE_UPDATE_OPTIONS = {
  closeButton: false,
  dismissible: false,
}

function runToastAction(action: () => Promise<void>): void {
  void action().catch((error: unknown) => {
    console.error('update toast action failed:', error)
  })
}

/** Mirrors the auto-update lifecycle into the global Sonner notification surface. */
export function UpdateToast(): ReactElement | null {
  const { state, install, restart } = useUpdate()

  useEffect(() => {
    switch (state.phase) {
      case 'available':
        toast.message('Update available', {
          id: UPDATE_TOAST_ID,
          description: `Reflect ${state.version} is ready to install.`,
          duration: PERSISTENT_TOAST_MS,
          ...NON_DISMISSIBLE_UPDATE_OPTIONS,
          action: {
            label: 'Install',
            onClick: () => runToastAction(install),
          },
        })
        break
      case 'downloading':
        toast.loading('Downloading update', {
          id: UPDATE_TOAST_ID,
          description: state.percent !== null ? `${state.percent}%` : 'Preparing…',
          duration: PERSISTENT_TOAST_MS,
          ...NON_DISMISSIBLE_UPDATE_OPTIONS,
        })
        break
      case 'ready':
        toast.success('Update ready', {
          id: UPDATE_TOAST_ID,
          description: `Reflect ${state.version} will finish updating after restart.`,
          duration: PERSISTENT_TOAST_MS,
          ...NON_DISMISSIBLE_UPDATE_OPTIONS,
          action: {
            label: 'Restart',
            onClick: () => runToastAction(restart),
          },
        })
        break
      case 'error':
        if (state.during === 'install') {
          toast.error('Update failed', {
            id: UPDATE_TOAST_ID,
            description: state.message,
            duration: PERSISTENT_TOAST_MS,
            ...NON_DISMISSIBLE_UPDATE_OPTIONS,
            action: {
              label: 'Retry install',
              onClick: () => runToastAction(install),
            },
          })
        } else {
          toast.dismiss(UPDATE_TOAST_ID)
        }
        break
      default:
        toast.dismiss(UPDATE_TOAST_ID)
        break
    }
  }, [install, restart, state])

  return null
}
