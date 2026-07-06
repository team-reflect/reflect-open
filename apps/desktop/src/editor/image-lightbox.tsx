import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { ExternalLinkIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LightboxDialog } from '@/editor/lightbox-dialog'
import { type LightboxTransitionItem } from '@/editor/use-lightbox-transition'
import { isMobileSurface } from '@/lib/platform-surface'
import { cn } from '@/lib/utils'

export const IMAGE_LIGHTBOX_TRANSITION_NAME = 'reflect-image-lightbox'

const DRAG_ACTIVATE_Y_PX = 8
const DRAG_DISARM_X_PX = 18
const DISMISS_FRACTION = 0.22
const DISMISS_VELOCITY_PX_PER_MS = 0.45
const MIN_FLICK_DY_PX = 40
const VELOCITY_WINDOW_MS = 30
const VELOCITY_STALE_MS = 120
const SETTLE_MS = 220
const SETTLE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const CLICK_SUPPRESSION_MS = 100

type DragState =
  | { phase: 'idle' }
  | { phase: 'armed'; pointerId: number; startX: number; startY: number }
  | {
      phase: 'dragging'
      pointerId: number
      startY: number
      height: number
      deltaY: number
      velocity: number
      sampleDeltaY: number
      sampleTime: number
    }
  | { phase: 'settling'; action: 'close' | 'cancel'; height: number }

const IDLE: DragState = { phase: 'idle' }

/** Image data rendered by the editor lightbox. */
export interface LightboxImage extends LightboxTransitionItem {
  /** Displayable URL, already resolved from the markdown `src`. */
  src: string
  alt: string
  /** Resolved image path to pass to `openImage`, or null for a remote image. */
  openPath: string | null
  /** Opener captured from the graph session that produced this preview. */
  openImage: ((path: string) => Promise<void> | void) | null
}

interface ImageLightboxProps {
  image: LightboxImage | null
  onClose: () => void
  onOpenImage?: (image: LightboxImage) => void
}

interface ImageDismissDrag {
  backdropStyle: CSSProperties | undefined
  previewStyle: CSSProperties | undefined
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  }
  finishSettle: () => void
}

function useImageDismissDrag({
  active,
  enabled,
  onClose,
}: {
  active: boolean
  enabled: boolean
  onClose: () => void
}): ImageDismissDrag {
  const stateRef = useRef<DragState>(IDLE)
  const [state, setState] = useState<DragState>(IDLE)
  const suppressClickUntilRef = useRef(0)

  const commit = useCallback((next: DragState): void => {
    stateRef.current = next
    setState(next)
  }, [])

  const finishSettle = useCallback((): void => {
    const current = stateRef.current
    if (current.phase !== 'settling') {
      return
    }
    commit(IDLE)
    if (current.action === 'cancel') {
      suppressClickUntilRef.current = 0
    }
    if (current.action === 'close') {
      onClose()
    }
  }, [commit, onClose])

  useEffect(() => {
    if ((!active || !enabled) && stateRef.current.phase !== 'idle') {
      suppressClickUntilRef.current = 0
      commit(IDLE)
    }
  }, [active, enabled, commit])

  useEffect(() => {
    if (state.phase !== 'settling') {
      return
    }
    const timer = window.setTimeout(finishSettle, SETTLE_MS + 80)
    return () => window.clearTimeout(timer)
  }, [state, finishSettle])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!enabled || event.pointerType !== 'touch' || !event.isPrimary) {
        return
      }
      if (stateRef.current.phase !== 'idle') {
        return
      }
      commit({
        phase: 'armed',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      })
    },
    [enabled, commit],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      const current = stateRef.current
      if (
        (current.phase !== 'armed' && current.phase !== 'dragging') ||
        current.pointerId !== event.pointerId
      ) {
        return
      }

      if (current.phase === 'armed') {
        const deltaX = Math.abs(event.clientX - current.startX)
        const deltaY = event.clientY - current.startY
        if (deltaX > DRAG_DISARM_X_PX && deltaX > Math.abs(deltaY)) {
          commit(IDLE)
          return
        }
        if (deltaY < -DRAG_ACTIVATE_Y_PX) {
          commit(IDLE)
          return
        }
        if (deltaY < DRAG_ACTIVATE_Y_PX || deltaY <= deltaX) {
          return
        }

        try {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        } catch {
          // Synthetic tests do not have a live pointer to capture.
        }

        const height = event.currentTarget.getBoundingClientRect().height || window.innerHeight
        commit({
          phase: 'dragging',
          pointerId: event.pointerId,
          startY: current.startY,
          height,
          deltaY,
          velocity: 0,
          sampleDeltaY: deltaY,
          sampleTime: performance.now(),
        })
        return
      }

      const deltaY = Math.max(0, event.clientY - current.startY)
      const now = performance.now()
      const elapsed = now - current.sampleTime
      if (elapsed < VELOCITY_WINDOW_MS) {
        commit({ ...current, deltaY })
        return
      }
      commit({
        ...current,
        deltaY,
        velocity: (deltaY - current.sampleDeltaY) / elapsed,
        sampleDeltaY: deltaY,
        sampleTime: now,
      })
    },
    [commit],
  )

  const release = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, interrupted: boolean): void => {
      const current = stateRef.current
      if (
        (current.phase !== 'armed' && current.phase !== 'dragging') ||
        current.pointerId !== event.pointerId
      ) {
        return
      }
      if (current.phase === 'armed') {
        commit(IDLE)
        return
      }

      const flicked =
        current.velocity > DISMISS_VELOCITY_PX_PER_MS &&
        current.deltaY > MIN_FLICK_DY_PX &&
        performance.now() - current.sampleTime <= VELOCITY_STALE_MS
      const shouldClose =
        !interrupted && (current.deltaY > current.height * DISMISS_FRACTION || flicked)
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      suppressClickUntilRef.current =
        performance.now() + (reducedMotion ? CLICK_SUPPRESSION_MS : SETTLE_MS + 80)

      if (reducedMotion) {
        commit(IDLE)
        if (shouldClose) {
          onClose()
        }
        return
      }

      commit({ phase: 'settling', action: shouldClose ? 'close' : 'cancel', height: current.height })
    },
    [commit, onClose],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => release(event, false),
    [release],
  )

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => release(event, true),
    [release],
  )

  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): void => {
      const settling = stateRef.current.phase === 'settling'
      const suppressClick =
        settling ||
        (suppressClickUntilRef.current > 0 && performance.now() <= suppressClickUntilRef.current)
      if (suppressClick) {
        if (!settling) {
          suppressClickUntilRef.current = 0
        }
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onClose()
    },
    [onClose],
  )

  return {
    backdropStyle: backdropStyleForState(state),
    previewStyle: previewStyleForState(state),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick },
    finishSettle,
  }
}

function dragProgress(deltaY: number, height: number): number {
  return Math.min(1, deltaY / Math.max(height * 0.55, 1))
}

function previewStyleForState(state: DragState): CSSProperties | undefined {
  if (state.phase === 'dragging') {
    const progress = dragProgress(state.deltaY, state.height)
    const scale = 1 - progress * 0.06
    return {
      opacity: 1 - progress * 0.12,
      transform: `translate3d(0, ${state.deltaY}px, 0) scale(${scale})`,
      transition: 'none',
    }
  }
  if (state.phase === 'settling') {
    const closing = state.action === 'close'
    return {
      opacity: closing ? 0 : 1,
      transform: closing
        ? `translate3d(0, ${state.height}px, 0) scale(0.94)`
        : 'translate3d(0, 0, 0) scale(1)',
      transition: `transform ${SETTLE_MS}ms ${SETTLE_EASING}, opacity ${SETTLE_MS}ms ${SETTLE_EASING}`,
    }
  }
  return undefined
}

function backdropStyleForState(state: DragState): CSSProperties | undefined {
  if (state.phase === 'dragging') {
    const progress = dragProgress(state.deltaY, state.height)
    return {
      opacity: 1 - progress * 0.58,
      transition: 'none',
    }
  }
  if (state.phase === 'settling') {
    return {
      opacity: state.action === 'close' ? 0 : 1,
      transition: `opacity ${SETTLE_MS}ms ${SETTLE_EASING}`,
    }
  }
  return undefined
}

export function ImageLightbox({
  image,
  onClose,
  onOpenImage,
}: ImageLightboxProps): ReactElement | null {
  const mobileSurface = isMobileSurface()
  const dismissDrag = useImageDismissDrag({
    active: image !== null,
    enabled: mobileSurface,
    onClose,
  })

  if (image === null) {
    return null
  }
  const canOpenImage =
    image.openPath !== null && image.openImage !== null && onOpenImage !== undefined

  return (
    <LightboxDialog open title="Image preview" onClose={onClose}>
      <div
        aria-hidden
        className={cn('absolute inset-0', mobileSurface ? 'bg-black' : 'bg-transparent')}
        style={mobileSurface ? dismissDrag.backdropStyle : undefined}
      />
      {mobileSurface ? (
        <div className="absolute top-[max(env(safe-area-inset-top),1rem)] left-[max(env(safe-area-inset-left),1rem)] z-10">
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label="Close"
            className="rounded-full bg-white/15 text-white shadow-sm backdrop-blur-xl hover:bg-white/25 active:bg-white/20"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {canOpenImage ? (
        <div className="absolute top-[max(env(safe-area-inset-top),1rem)] right-[max(env(safe-area-inset-right),1rem)] z-10">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'shadow-sm',
              mobileSurface
                ? 'h-9 rounded-full bg-white/15 px-3 text-white backdrop-blur-xl hover:bg-white/25 active:bg-white/20'
                : 'bg-white/70 text-text hover:bg-white',
            )}
            onClick={() => onOpenImage(image)}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            Open
          </Button>
        </div>
      ) : null}
      <button
        type="button"
        aria-label="Close image preview"
        className={cn(
          'absolute inset-0 flex cursor-zoom-out items-center justify-center overflow-hidden bg-transparent',
          mobileSurface ? 'touch-none p-0' : 'p-6',
        )}
        {...dismissDrag.handlers}
      >
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          className="h-full w-full select-none object-contain"
          onTransitionEnd={dismissDrag.finishSettle}
          style={{ ...dismissDrag.previewStyle, viewTransitionName: image.transitionName }}
        />
      </button>
    </LightboxDialog>
  )
}
