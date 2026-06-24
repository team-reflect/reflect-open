import type { ReactElement } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useTheme } from '@/providers/theme-provider'

const TOAST_CLASS_NAMES = {
  toast:
    'group toast group-[.toaster]:border-border group-[.toaster]:bg-surface group-[.toaster]:text-text group-[.toaster]:shadow-lg',
  description: 'group-[.toast]:text-text-muted',
  actionButton:
    'group-[.toast]:bg-accent group-[.toast]:text-text-on-brand group-[.toast]:hover:bg-accent-hover',
  cancelButton: 'group-[.toast]:bg-surface-hover group-[.toast]:text-text-secondary',
}

function Toaster({
  closeButton = true,
  position = 'bottom-right',
  toastOptions,
  ...props
}: ToasterProps): ReactElement {
  const { theme } = useTheme()

  return (
    <Sonner
      closeButton={closeButton}
      position={position}
      theme={theme}
      className="toaster group"
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...TOAST_CLASS_NAMES,
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
