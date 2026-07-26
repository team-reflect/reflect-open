import { useRef, type ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { useBackSwipe } from './use-back-swipe'

/**
 * The scroll blocker's lifecycle: the non-passive `touchmove` listener must
 * exist only while a touch owns the gesture (armed → dragging) — a
 * permanently attached one would tax every scroll in the app — and it must
 * cancel the page's scroll only in the dragging phase. Driven with real
 * pointer/touch events; `reducedMotion` keeps release synchronous (no
 * settle transition to wait out).
 */

interface HarnessProps {
  readonly enabled?: boolean
}

function Harness({ enabled = true }: HarnessProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const swipe = useBackSwipe({
    enabled,
    reducedMotion: true,
    onPop: () => {},
    containerRef,
  })
  return (
    <div
      ref={containerRef}
      data-testid="stack"
      style={{ width: '400px', height: '400px' }}
      {...swipe.handlers}
    />
  )
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  node: Element,
  clientX: number,
  clientY: number,
): void {
  node.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerType: 'touch',
      isPrimary: true,
      pointerId: 1,
      clientX,
      clientY,
    }),
  )
}

function touchMove(node: Element): TouchEvent {
  const event = new TouchEvent('touchmove', { bubbles: true, cancelable: true })
  node.dispatchEvent(event)
  return event
}

/** A listener spy, structurally — `vi.spyOn`'s overloads defeat ReturnType. */
interface ListenerSpy {
  readonly mock: { readonly calls: readonly unknown[][] }
}

interface SwipeSetup {
  readonly node: Element
  readonly edgeX: number
  readonly edgeY: number
  readonly added: ListenerSpy
  readonly removed: ListenerSpy
}

async function setup(enabled = true): Promise<SwipeSetup> {
  const screen = await render(<Harness enabled={enabled} />)
  const node = screen.getByTestId('stack').element()
  const rect = node.getBoundingClientRect()
  return {
    node,
    edgeX: rect.left + 10,
    edgeY: rect.top + 100,
    added: vi.spyOn(node, 'addEventListener'),
    removed: vi.spyOn(node, 'removeEventListener'),
  }
}

function touchmoveCalls(spy: ListenerSpy): number {
  return spy.mock.calls.filter((listenerCall) => listenerCall[0] === 'touchmove').length
}

describe('useBackSwipe scroll blocker', () => {
  it('is not attached at idle, and idle touchmoves stay cancelable', async () => {
    const { node, added } = await setup()
    expect(touchMove(node).defaultPrevented).toBe(false)
    expect(touchmoveCalls(added)).toBe(0)
  })

  it('attaches on arm, cancels scroll while dragging, detaches on release', async () => {
    const { node, edgeX, edgeY, added, removed } = await setup()

    pointer('pointerdown', node, edgeX, edgeY)
    expect(touchmoveCalls(added)).toBe(1)
    // Armed but not yet dragging: the page's scroll must survive.
    expect(touchMove(node).defaultPrevented).toBe(false)

    pointer('pointermove', node, edgeX + 20, edgeY)
    expect(touchMove(node).defaultPrevented).toBe(true)

    pointer('pointerup', node, edgeX + 20, edgeY)
    expect(touchmoveCalls(removed)).toBe(1)
    expect(touchMove(node).defaultPrevented).toBe(false)
  })

  it('detaches when a vertical scroll disarms the gesture', async () => {
    const { node, edgeX, edgeY, added, removed } = await setup()

    pointer('pointerdown', node, edgeX, edgeY)
    expect(touchmoveCalls(added)).toBe(1)

    pointer('pointermove', node, edgeX, edgeY + 40)
    expect(touchmoveCalls(removed)).toBe(1)
    expect(touchMove(node).defaultPrevented).toBe(false)
  })

  it('never attaches while disabled', async () => {
    const { node, edgeX, edgeY, added } = await setup(false)
    pointer('pointerdown', node, edgeX, edgeY)
    expect(touchmoveCalls(added)).toBe(0)
  })
})
