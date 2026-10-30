import { act } from '@/test-utils/act.ts'

/** Dispatch one primary-touch pointer event on `node`. */
export async function pointer(
  node: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
): Promise<void> {
  await act(() => {
    node.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true,
        pointerId: 1,
        clientX,
        clientY,
      }),
    )
  })
}
