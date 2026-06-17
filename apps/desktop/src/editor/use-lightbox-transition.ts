import { useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/** Data rendered in a lightbox with a named View Transition snapshot. */
export interface LightboxTransitionItem {
  readonly transitionName: string
}

interface LightboxTransitionSource<ElementType extends HTMLElement> {
  element: ElementType
  transitionName: string
}

interface UseLightboxTransitionOptions<
  ElementType extends HTMLElement,
  ItemType extends LightboxTransitionItem,
> {
  transitionName: string
  createItem: (element: ElementType, transitionName: string) => ItemType | null
}

/** State and commands for a lightbox that zooms from a source element when possible. */
export interface UseLightboxTransitionResult<
  ElementType extends HTMLElement,
  ItemType extends LightboxTransitionItem,
> {
  item: ItemType | null
  open: (element: ElementType) => void
  close: () => void
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function canUseViewTransition(): boolean {
  return typeof document.startViewTransition === 'function' && !prefersReducedMotion()
}

function clearTransitionSource<ElementType extends HTMLElement>(
  source: LightboxTransitionSource<ElementType> | null,
): void {
  if (source !== null && source.element.style.viewTransitionName === source.transitionName) {
    source.element.style.viewTransitionName = ''
  }
}

function settleViewTransition(transition: ViewTransition, cleanup: () => void): void {
  void transition.finished.then(cleanup, cleanup)
}

/**
 * Opens and closes lightbox content with a native View Transition when supported.
 */
export function useLightboxTransition<
  ElementType extends HTMLElement,
  ItemType extends LightboxTransitionItem,
>({
  transitionName,
  createItem,
}: UseLightboxTransitionOptions<ElementType, ItemType>): UseLightboxTransitionResult<
  ElementType,
  ItemType
> {
  const sourceRef = useRef<LightboxTransitionSource<ElementType> | null>(null)
  const [item, setItem] = useState<ItemType | null>(null)

  const open = useCallback((element: ElementType) => {
    const nextItem = createItem(element, transitionName)
    if (nextItem === null) {
      return
    }

    clearTransitionSource(sourceRef.current)
    const source: LightboxTransitionSource<ElementType> = {
      element,
      transitionName,
    }
    sourceRef.current = source

    if (!canUseViewTransition()) {
      setItem(nextItem)
      return
    }

    element.style.viewTransitionName = transitionName
    const transition = document.startViewTransition(() => {
      clearTransitionSource(source)
      flushSync(() => setItem(nextItem))
    })
    settleViewTransition(transition, () => clearTransitionSource(source))
  }, [createItem, transitionName])

  const close = useCallback(() => {
    if (item === null) {
      return
    }

    const source = sourceRef.current
    if (canUseViewTransition() && source?.element.isConnected) {
      const transition = document.startViewTransition(() => {
        flushSync(() => setItem(null))
        source.element.style.viewTransitionName = item.transitionName
      })
      settleViewTransition(transition, () => {
        clearTransitionSource(source)
        sourceRef.current = null
      })
      return
    }

    setItem(null)
    clearTransitionSource(source)
    sourceRef.current = null
  }, [item])

  return { item, open, close }
}
