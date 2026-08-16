import type { ReactElement, ReactNode } from 'react'
import { Toast as ToastPrimitive } from '@base-ui/react/toast'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  XIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react'

/** Per-toast flags carried in the manager's `data` payload. */
interface ToastData {
  /** `false` hides the close button and disables swipe-to-dismiss. */
  dismissible?: boolean
}

const toast = ToastPrimitive.createToastManager<ToastData>()

type ToasterPosition = 'bottom-right' | 'top-center'

const VIEWPORT_POSITION_CLASSES: Record<ToasterPosition, string> = {
  'bottom-right': 'inset-x-4 bottom-4 sm:right-4 sm:left-auto sm:mx-0 sm:w-full',
  // max(env(safe-area-inset-top), 1rem) keeps the stack below the iOS camera
  // pill: viewport-fit=cover (index.html) extends the webview underneath it.
  'top-center': 'inset-x-4 top-[max(env(safe-area-inset-top),1rem)]',
}

// The structural y terms of the stacking transforms, per anchor edge. The
// top-center strings are the generated bottom-anchored ones with every
// non-swipe y sign flipped: the stack grows downward and toasts enter and
// leave through the top edge.
const TOAST_POSITION_CLASSES: Record<ToasterPosition, string> = {
  'bottom-right': cn(
    'bottom-0 origin-bottom',
    '[--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))]',
    '[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))]',
    'data-starting-style:[transform:translateY(150%)]',
    '[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]',
  ),
  'top-center': cn(
    'top-0 origin-top',
    '[--offset-y:calc(var(--toast-offset-y)+calc(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))]',
    '[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height))))_scale(var(--scale))]',
    'data-starting-style:[transform:translateY(-150%)]',
    '[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(-150%)]',
  ),
}

const TOAST_SWIPE_DIRECTIONS: Record<ToasterPosition, ('up' | 'down' | 'right')[]> = {
  'bottom-right': ['down', 'right'],
  'top-center': ['up'],
}

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props): ReactElement {
  return <ToastPrimitive.Provider {...props} />
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props): ReactElement {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />
}

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props): ReactElement {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        'pointer-events-none fixed z-50 mx-auto w-auto max-w-sm outline-none',
        className,
      )}
      {...props}
    />
  )
}

function Toast({
  className,
  position = 'bottom-right',
  ...props
}: ToastPrimitive.Root.Props & { position?: ToasterPosition }): ReactElement {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        'group/toast pointer-events-auto absolute right-0 z-[calc(1000-var(--toast-index))] w-full rounded-2xl border bg-popover text-popover-foreground shadow-lg will-change-transform outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        '[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]',
        'h-(--height) [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms]',
        "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        'data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]',
        'data-limited:opacity-0',
        'data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]',
        'data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]',
        'data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]',
        'data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]',
        'data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]',
        'data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]',
        'data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]',
        'data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]',
        TOAST_POSITION_CLASSES[position],
        className,
      )}
      {...props}
    />
  )
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props): ReactElement {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        'flex h-full items-center gap-3 overflow-hidden p-4 transition-opacity duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100',
        className,
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props): ReactElement {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn('text-sm font-medium', className)}
      {...props}
    />
  )
}

function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props): ReactElement {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function ToastAction({
  className,
  render = <Button variant="outline" size="sm" />,
  ...props
}: ToastPrimitive.Action.Props): ReactElement {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn('shrink-0', className)}
      {...props}
    />
  )
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-sm" />,
  ...props
}: ToastPrimitive.Close.Props): ReactElement {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Close toast"
      render={render}
      className={cn(
        "relative shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </ToastPrimitive.Close>
  )
}

function ToastIcon({ type }: { type: string | undefined }): ReactElement | null {
  let icon: ReactNode = null

  if (type === 'success') {
    icon = <CircleCheckIcon aria-hidden="true" />
  }

  if (type === 'info') {
    icon = <InfoIcon aria-hidden="true" />
  }

  if (type === 'warning') {
    icon = <TriangleAlertIcon aria-hidden="true" />
  }

  if (type === 'error') {
    icon = <OctagonXIcon className="text-destructive" aria-hidden="true" />
  }

  if (type === 'loading') {
    icon = <Loader2Icon className="animate-spin" aria-hidden="true" />
  }

  if (!icon) {
    return null
  }

  return (
    <span
      data-slot="toast-icon"
      className="shrink-0 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4"
    >
      {icon}
    </span>
  )
}

function ToastList({ position }: { position: ToasterPosition }): ReactElement[] {
  const { toasts } = ToastPrimitive.useToastManager<ToastData>()

  return toasts.map((toastItem) => {
    const dismissible = toastItem.data?.dismissible !== false
    return (
      <Toast
        key={toastItem.id}
        toast={toastItem}
        position={position}
        swipeDirection={dismissible ? TOAST_SWIPE_DIRECTIONS[position] : []}
      >
        <ToastContent>
          <ToastIcon type={toastItem.type} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ToastTitle />
            <ToastDescription />
          </div>
          <ToastAction />
          {dismissible ? <ToastClose /> : null}
        </ToastContent>
      </Toast>
    )
  })
}

function Toaster({
  children,
  position = 'bottom-right',
  toastManager = toast,
  ...props
}: ToastPrimitive.Provider.Props & { position?: ToasterPosition }): ReactElement {
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      <ToastPortal>
        <ToastViewport className={VIEWPORT_POSITION_CLASSES[position]}>
          <ToastList position={position} />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}

const createToastManager = ToastPrimitive.createToastManager
const useToastManager = ToastPrimitive.useToastManager

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  useToastManager,
}
export type { ToastData }
