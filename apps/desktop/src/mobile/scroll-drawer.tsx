import {
  createContext,
  use,
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { linkOpacityToScroll } from '@/lib/scroll-linked-opacity.ts'
import { watchScrollSettle } from '@/lib/scroll-settle.ts'
import { cn } from '@/lib/utils.ts'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion.ts'
import './scroll-drawer.css'

interface DrawerContextValue {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const DrawerContext = createContext<DrawerContextValue | null>(null)

function useDrawer(): DrawerContextValue {
  const context = use(DrawerContext)
  if (context === null) {
    throw new Error('Drawer parts must be rendered inside <Drawer>.')
  }
  return context
}

export interface DrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children?: ReactNode | undefined
}

/**
 * A modal bottom sheet that moves by native scrolling. A finger, or a mouse
 * drag, moves a scroll container and CSS scroll snap settles it, so the sheet follows the
 * finger at the display's refresh rate even while the main thread is busy.
 * Base UI's `Dialog` owns focus, `inert`, Escape, and the dialog role.
 */
export function Drawer({ open, onOpenChange, children }: DrawerProps): ReactElement {
  const contextValue = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange])
  const handleOpenChange = useCallback((next: boolean) => onOpenChange(next), [onOpenChange])
  return (
    <DrawerContext value={contextValue}>
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        {children}
      </DialogPrimitive.Root>
    </DrawerContext>
  )
}

export function DrawerTrigger(props: DialogPrimitive.Trigger.Props): ReactElement {
  return <DialogPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

export type DrawerContentProps = Pick<
  DialogPrimitive.Popup.Props,
  'aria-label' | 'initialFocus'
> & {
  children?: ReactNode | undefined
}

export function DrawerContent({
  children,
  initialFocus,
  ...props
}: DrawerContentProps): ReactElement {
  const popupRef = useRef<HTMLDivElement>(null)
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Popup
        ref={popupRef}
        data-slot="drawer-content"
        // Focus the sheet, not its first field, so opening never raises the keyboard.
        initialFocus={initialFocus ?? popupRef}
        className="scroll-drawer-popup fixed inset-0 z-50 outline-none"
        {...props}
      >
        <DrawerSheet popupRef={popupRef}>{children}</DrawerSheet>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function DrawerSheet({
  popupRef,
  children,
}: {
  popupRef: RefObject<HTMLDivElement | null>
  children?: ReactNode | undefined
}): ReactElement {
  const { open, onOpenChange } = useDrawer()
  const reducedMotion = usePrefersReducedMotion()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const slideRef = useRef<HTMLDivElement>(null)
  const tintRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<ScrollDrawerController | null>(null)
  // Bumped by each swipe close. A render that still has `open` means the owner refused.
  const [closeRequests, setCloseRequests] = useState(0)

  const requestClose = useEffectEvent((): void => {
    setCloseRequests((count) => count + 1)
    onOpenChange(false)
  })
  const prefersReducedMotion = useEffectEvent(() => reducedMotion)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const isOpen = useEffectEvent(() => open)

  useLayoutEffect(() => {
    if (closeRequests > 0 && isOpen()) {
      controllerRef.current?.keepOpen()
    }
  }, [closeRequests])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const slide = slideRef.current
    const tint = tintRef.current
    if (scroller === null || slide === null || tint === null) {
      return
    }
    const controller = attachScrollDrawer({
      scroller,
      slide,
      tint,
      popup: () => popupRef.current,
      requestClose,
      prefersReducedMotion,
    })
    controllerRef.current = controller
    return () => {
      controllerRef.current = null
      controller.detach()
    }
  }, [popupRef])

  return (
    <>
      <div aria-hidden className="scroll-drawer-backdrop">
        <div ref={tintRef} className="scroll-drawer-tint size-full bg-black/30" />
      </div>
      <div ref={scrollerRef} className="scroll-drawer">
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="scroll-drawer-spacer"
          onClick={close}
        />
        <div ref={slideRef} className="scroll-drawer-slide">
          <div className="scroll-drawer-panel flex min-h-0 flex-1 flex-col rounded-t-xl bg-popover text-sm text-popover-foreground inset-ring-1 inset-ring-foreground/10 select-text pb-above-keyboard px-safe">
            <div aria-hidden className="mx-auto my-1 h-1 w-10 shrink-0 rounded-full bg-border" />
            <DialogPrimitive.Close className="sr-only">Close</DialogPrimitive.Close>
            {children}
          </div>
        </div>
      </div>
    </>
  )
}

export function DrawerTitle({ className, ...props }: DialogPrimitive.Title.Props): ReactElement {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn('font-heading text-base leading-none font-medium px-8 pt-6', className)}
      {...props}
    />
  )
}

/**
 * The scrollable middle of a drawer. At its top edge a downward drag chains to
 * the sheet's scroller, so the same gesture closes the drawer.
 */
export function DrawerBody({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      data-slot="drawer-body"
      className={cn(
        'flex min-h-0 scroll-fade-t flex-col overflow-y-auto px-8 pb-8 pt-4 gap-4',
        className,
      )}
      {...props}
    />
  )
}

export function DrawerDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props): ReactElement {
  return (
    <DialogPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

interface ScrollDrawerOptions {
  scroller: HTMLElement
  slide: HTMLElement
  tint: HTMLElement
  popup: () => HTMLElement | null
  /**
   * Asks the owner to close. The owner may keep the drawer open.
   */
  requestClose: () => void
  prefersReducedMotion: () => boolean
}

interface ScrollDrawerController {
  /**
   * Scrolls the sheet back open after the owner refused a swipe close.
   */
  keepOpen: () => void
  detach: () => void
}

/**
 * Wires the sheet's scroller: starts it open, closes the drawer when a user
 * scroll leaves the sheet off screen, and keeps it open while the sheet
 * resizes.
 */
function attachScrollDrawer({
  scroller,
  slide,
  tint,
  popup,
  requestClose,
  prefersReducedMotion,
}: ScrollDrawerOptions): ScrollDrawerController {
  const listeners = new AbortController()
  const { signal } = listeners
  // Layout offsets ignore `translate`, so the entry transition never moves this.
  const openTop = (): number => slide.offsetTop + slide.offsetHeight - scroller.clientHeight
  const scrollOpen = (): void => {
    scroller.scrollTo({ top: openTop(), behavior: prefersReducedMotion() ? 'instant' : 'smooth' })
  }

  let slideHidden = false
  let handled = false

  scroller.scrollTop = openTop()

  // Acts once each time the slide leaves the scrollport, after the finger lifts.
  const settle = (): void => {
    if (!slideHidden || handled || watch.isTouching()) {
      return
    }
    handled = true
    if (!watch.isUserScroll()) {
      // A focus reveal or a resize moved the sheet: never close for those.
      scrollOpen()
      return
    }
    popup()?.setAttribute('data-closed-by', 'swipe')
    requestClose()
  }

  const watch = watchScrollSettle({
    element: scroller,
    onSettle: settle,
    signal,
    isSettled: () => scroller.scrollTop <= 1,
  })

  // The slide leaves the scrollport only at the closed snap point.
  const visibility = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1)
      if (entry === undefined) {
        return
      }
      slideHidden = !entry.isIntersecting
      if (slideHidden) {
        settle()
      } else {
        handled = false
      }
    },
    { root: scroller, rootMargin: '0px 0px -1px 0px' },
  )
  visibility.observe(slide)

  // Content growth, the keyboard padding, or a rotation moves the open snap point.
  const resize = new ResizeObserver(() => {
    if (!watch.isTouching() && !slideHidden) {
      scroller.scrollTop = openTop()
    }
  })
  resize.observe(slide)
  resize.observe(scroller)

  linkOpacityToScroll({ target: tint, scroller, axis: 'y', from: 0, to: 1, signal })

  return {
    keepOpen: () => {
      popup()?.removeAttribute('data-closed-by')
      scrollOpen()
    },
    detach: () => {
      listeners.abort()
      visibility.disconnect()
      resize.disconnect()
    },
  }
}
