import type { ToastService } from '@reflect/app'
import { toast } from '@/components/ui/toast.tsx'

/**
 * The {@link ToastService} over the Base UI toast manager that `<Toaster />`
 * renders. Every field is passed, even when `undefined`: showing an open id
 * merges into that toast, so a missing field would keep its old value.
 */
export function createBaseUiToastService(): ToastService {
  return {
    show: (spec) => {
      toast.add({
        id: spec.id,
        title: spec.title,
        description: spec.description,
        type: spec.type,
        timeout: spec.timeout,
        data: spec.dismissible === undefined ? {} : { dismissible: spec.dismissible },
        actionProps: spec.action
          ? { children: spec.action.label, onClick: spec.action.run }
          : undefined,
        onClose: spec.onClose,
      })
    },
    close: (id) => {
      toast.close(id)
    },
  }
}
