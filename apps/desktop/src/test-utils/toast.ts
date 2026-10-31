import type { ToastManagerAddOptions } from '@base-ui/react/toast'
import type { ToastData } from '@/components/ui/toast.tsx'

export type MockToastAddOptions = Omit<ToastManagerAddOptions<ToastData>, 'actionProps'> & {
  actionProps?: { children: string; onClick: () => void }
}
