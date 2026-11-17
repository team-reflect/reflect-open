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
import { useChromeModal } from '@/mobile/chrome/chrome-renderer.ts'
import './scroll-drawer.css'

/**
 * How far (px) past the screen edge the closed snap point leaves the sheet.
 * The slow end of the release deceleration then runs off screen, and the
 * drawer closes as soon as the sheet leaves the screen.
 */
export const DRAWER_OVERSHOOT_PX = 50

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

/**
 * The props of {@link Drawer}. The drawer is always controlled.
 */
export interface DrawerProps {
  /**
   * Whether the drawer is open.
   */
  open: boolean
  /**
   * Called when a swipe, a tap above the sheet, or Escape asks to close, and
   * when a trigger asks to open. The owner may keep the drawer open.
   */
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
  useChromeModal(open)
  return (
    <DrawerContext value={contextValue}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        {children}
      </DialogPrimitive.Root>
    </DrawerContext>
  )
}

/**
 * A button that opens the drawer.
 */
export function DrawerTrigger(props: DialogPrimitive.Trigger.Props): ReactElement {
  return <DialogPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

/**
 * The props of {@link DrawerContent}. `initialFocus` defaults to the sheet
 * itself, so opening never raises the keyboard.
 */
export type DrawerContentProps = Pick<
  DialogPrimitive.Popup.Props,
  'aria-label' | 'initialFocus'
> & {
  children?: ReactNode | undefined
}

/**
 * The sheet, its backdrop, and its scroller, in a portal. Children render in
 * the panel under the grab handle.
 */
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
  const scrollerRef = useRef<HTMLDivElement>(null)
  const slideRef = useRef<HTMLDivElement>(null)
  const tintRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<ScrollDrawerController | null>(null)
  // Bumped by each swipe close. A render that still has `open` means the owner refused.
  const [closeRequests, setCloseRequests] = useState(0)

  const requestClose = useEffectEvent((): void => {
    setCloseRequests((count) => count + 1)
    onOpenChange(false)
  })
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
    const handle = handleRef.current
    if (scroller === null || slide === null || tint === null || handle === null) {
      return
    }
    const controller = attachScrollDrawer({
      scroller,
      slide,
      tint,
      handle,
      popup: () => popupRef.current,
      requestClose,
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
          style={{ height: `calc(100% + ${DRAWER_OVERSHOOT_PX}px)` }}
          onClick={close}
        />
        <div ref={slideRef} className="scroll-drawer-slide">
          <div className="scroll-drawer-panel flex min-h-0 flex-1 flex-col rounded-t-xl bg-popover text-sm text-popover-foreground inset-ring-1 inset-ring-foreground/10 select-text pb-above-keyboard px-safe">
            <div aria-hidden className="mx-auto my-1 h-1 w-10 shrink-0 rounded-full bg-border" />
            <DialogPrimitive.Close className="sr-only">Close</DialogPrimitive.Close>
            {children}
          </div>
          {/* The mouse drags the sheet only from its top edge (the grab
              handle), so a mouse press in the content can select text. */}
          <div ref={handleRef} aria-hidden className="absolute inset-x-0 top-0 h-6" />
        </div>
      </div>
    </>
  )
}

/**
 * The drawer's heading. It names the dialog.
 */
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

/**
 * Muted text that describes the dialog.
 */
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
  /**
   * Where a mouse drag may start.
   */
  handle: HTMLElement
  popup: () => HTMLElement | null
  /**
   * Asks the owner to close. The owner may keep the drawer open.
   */
  requestClose: () => void
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
  handle,
  popup,
  requestClose,
}: ScrollDrawerOptions): ScrollDrawerController {
  const listeners = new AbortController()
  const { signal } = listeners
  // Layout offsets ignore `translate`, so the entry transition never moves this.
  const openTop = (): number => slide.offsetTop + slide.offsetHeight - scroller.clientHeight
  const scrollOpen = (): void => {
    scroller.scrollTo({ top: openTop(), behavior: 'smooth' })
  }

  // The spacer is one scrollport plus the overshoot high, so the slide is off
  // screen from here down to the closed snap point.
  const isClosed = (): boolean => scroller.scrollTop <= DRAWER_OVERSHOOT_PX + 1

  scroller.scrollTop = openTop()

  // Acts once the sheet is off screen or rests, after the finger lifts.
  // Only a gesture since the sheet last rested open may close it: a resize or
  // a re-snap that moves the sheet there on its own scrolls it back open. A
  // sheet that stops between the snap points (a touch that stops the snap
  // does not snap again in WebKit) scrolls on to the nearer one.
  let gesturesAtOpen = 0
  const watch = watchScrollSettle({
    element: scroller,
    signal,
    isSettled: isClosed,
    dragHandle: handle,
    onSettle: () => {
      if (!isClosed()) {
        // `openTop` adds up rounded offsets; the scroll range bounds the real one.
        const top = Math.min(openTop(), scroller.scrollHeight - scroller.clientHeight)
        if (scroller.scrollTop >= top - 1) {
          gesturesAtOpen = watch.gestures()
          return
        }
        scroller.scrollTo({
          // The midpoint of the part of the travel where the sheet shows.
          top: scroller.scrollTop < (DRAWER_OVERSHOOT_PX + top) / 2 ? 0 : top,
          behavior: 'smooth',
        })
        return
      }
      if (watch.gestures() === gesturesAtOpen) {
        scrollOpen()
        return
      }
      popup()?.setAttribute('data-closed-by', 'swipe')
      requestClose()
    },
  })

  // Content growth, the keyboard padding, or a rotation moves the open snap point.
  const resize = new ResizeObserver(() => {
    if (!watch.isTouching() && !isClosed()) {
      scroller.scrollTop = openTop()
    }
  })
  resize.observe(slide)
  resize.observe(scroller)

  linkOpacityToScroll({
    target: tint,
    scroller,
    axis: 'y',
    start: DRAWER_OVERSHOOT_PX,
    from: 0,
    to: 1,
    signal,
  })

  return {
    keepOpen: () => {
      popup()?.removeAttribute('data-closed-by')
      scrollOpen()
    },
    detach: () => {
      listeners.abort()
      resize.disconnect()
    },
  }
}
