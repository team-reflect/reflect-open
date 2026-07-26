import {
  useCallback,
  useEffect,
  useRef,
  type CompositionEventHandler,
  type KeyboardEvent,
  type KeyboardEventHandler,
} from 'react'

const IME_PROCESS_KEY_CODE = 229

interface ImeCompositionGuard<ElementType extends HTMLElement> {
  readonly isImeKeyEvent: (event: KeyboardEvent<ElementType>) => boolean
  readonly onCompositionStart: CompositionEventHandler<ElementType>
  readonly onCompositionEnd: CompositionEventHandler<ElementType>
  readonly onKeyUp: KeyboardEventHandler<ElementType>
}

/**
 * Identifies keyboard events that belong to an IME composition, including
 * WebKit's conversion-confirmation event emitted just after `compositionend`.
 */
export function useImeCompositionGuard<
  ElementType extends HTMLElement,
>(): ImeCompositionGuard<ElementType> {
  const compositionJustEndedRef = useRef(false)
  const resetTimerRef = useRef<number | null>(null)

  const cancelReset = useCallback((): void => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  useEffect(() => cancelReset, [cancelReset])

  const onCompositionStart = useCallback((): void => {
    cancelReset()
    compositionJustEndedRef.current = false
  }, [cancelReset])

  const onCompositionEnd = useCallback((): void => {
    compositionJustEndedRef.current = true
    resetTimerRef.current = window.setTimeout(() => {
      compositionJustEndedRef.current = false
      resetTimerRef.current = null
    }, 0)
  }, [])

  const onKeyUp = useCallback((): void => {
    compositionJustEndedRef.current = false
  }, [])

  const isImeKeyEvent = useCallback((event: KeyboardEvent<ElementType>): boolean => {
    const nativeEvent = event.nativeEvent
    return (
      compositionJustEndedRef.current ||
      nativeEvent.isComposing ||
      nativeEvent.key === 'Process' ||
      nativeEvent.keyCode === IME_PROCESS_KEY_CODE ||
      nativeEvent.which === IME_PROCESS_KEY_CODE
    )
  }, [])

  return { isImeKeyEvent, onCompositionStart, onCompositionEnd, onKeyUp }
}
