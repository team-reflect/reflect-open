import { act, cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { BacklinkSnippetData } from '@/lib/group-backlinks'
import { BacklinkSnippetList } from './backlink-snippet-list'

vi.mock('@/components/backlink-snippet', () => ({
  BacklinkSnippet: ({ text }: { text: string }) => (
    <span data-backlink-snippet-probe>{text}</span>
  ),
}))

const observerInstances: TestIntersectionObserver[] = []
const resizeObserverInstances: TestResizeObserver[] = []
const scheduledFrames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly scrollMargin = '0px'
  readonly thresholds: readonly number[]
  readonly targets = new Set<Element>()

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
    const threshold = options.threshold ?? 0
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold]
    observerInstances.push(this)
  }

  disconnect(): void {
    this.targets.clear()
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  notify(isIntersecting = true): void {
    const entries = [...this.targets].map((target): IntersectionObserverEntry => {
      const bounds = target.getBoundingClientRect()
      return {
        boundingClientRect: bounds,
        intersectionRatio: isIntersecting ? 1 : 0,
        intersectionRect: bounds,
        isIntersecting,
        rootBounds: null,
        target,
        time: 0,
      }
    })
    this.callback(entries, this)
  }
}

class TestResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverInstances.push(this)
  }

  disconnect(): void {
    this.targets.clear()
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  notify(): void {
    const entries = [...this.targets].map((target): ResizeObserverEntry => ({
      borderBoxSize: [],
      contentBoxSize: [],
      contentRect: target.getBoundingClientRect(),
      devicePixelContentBoxSize: [],
      target,
    }))
    this.callback(entries, this)
  }
}

function installObservationEnvironment(): void {
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const frame = nextFrame
    nextFrame += 1
    scheduledFrames.set(frame, callback)
    return frame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number): void => {
    scheduledFrames.delete(frame)
  })
}

function preloadObserver(root?: Element | Document | null): TestIntersectionObserver {
  for (let index = observerInstances.length - 1; index >= 0; index -= 1) {
    const observer = observerInstances[index]
    if (
      observer?.rootMargin === '600px 0px' &&
      (root === undefined || observer.root === root)
    ) {
      return observer
    }
  }
  throw new Error('expected a preload IntersectionObserver')
}

function flushNextFrame(): void {
  const next = scheduledFrames.entries().next()
  if (next.done) {
    throw new Error('expected a scheduled animation frame')
  }
  const [frame, callback] = next.value
  scheduledFrames.delete(frame)
  callback(0)
}

function rect(top: number, height = 20, left = 0, width = 300): DOMRect {
  return new DOMRect(left, top, width, height)
}

function snippets(prefix: string, count: number): BacklinkSnippetData[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${index}`,
    text: `${prefix} ${index}`,
    tasks: [],
  }))
}

function snippetList(prefix: string, count: number): ReactElement {
  return (
    <BacklinkSnippetList
      snippets={snippets(prefix, count)}
      notePath={`notes/${prefix}.md`}
      sourceTitle={`${prefix} source`}
      className="space-y-1"
      onWikilinkClick={() => {}}
      resolveImageUrl={() => undefined}
    />
  )
}

function renderedSnippetCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-backlink-snippet-probe]').length
}

afterEach(() => {
  cleanup()
  scheduledFrames.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BacklinkSnippetList', () => {
  it('mounts at most one rich snippet per animation frame', () => {
    installObservationEnvironment()
    const view = render(snippetList('bounded', 7))

    expect(renderedSnippetCount(view.container)).toBe(0)
    act(() => preloadObserver().notify())
    expect(scheduledFrames.size).toBe(1)

    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(1)

    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(2)
  })

  it('rechecks live geometry instead of draining stale offscreen work', () => {
    installObservationEnvironment()
    const view = render(snippetList('geometry', 2))
    const placeholders = view.getAllByRole('button', { name: /Show reference/ })
    let secondTop = 0
    vi.spyOn(placeholders[0]!, 'getBoundingClientRect').mockImplementation(() => rect(0))
    vi.spyOn(placeholders[1]!, 'getBoundingClientRect').mockImplementation(() => rect(secondTop))

    act(() => preloadObserver().notify())
    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(1)

    secondTop = 5_000
    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(1)
    expect(scheduledFrames.size).toBe(0)

    secondTop = 0
    act(() => preloadObserver().notify())
    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(2)
  })

  it('preloads against the nearest nested note scroller', () => {
    installObservationEnvironment()
    const view = render(
      <div data-testid="scroller" style={{ height: 200, overflowY: 'auto' }}>
        {snippetList('nested', 1)}
      </div>,
    )
    const scroller = view.getByTestId('scroller')
    const placeholder = view.getByRole('button', { name: /Show reference/ })
    let targetTop = 2_000
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => rect(100, 200))
    vi.spyOn(placeholder, 'getBoundingClientRect').mockImplementation(() => rect(targetTop))

    const observer = preloadObserver(scroller)
    expect(observer.rootMargin).toBe('600px 0px')
    act(() => observer.notify(false))
    expect(renderedSnippetCount(view.container)).toBe(0)

    targetTop = 850
    act(() => observer.notify())
    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(1)
  })

  it('lets assistive and keyboard users explicitly reveal a reference', async () => {
    installObservationEnvironment()
    const view = render(snippetList('accessible', 1))

    const button = view.getByRole('button', {
      name: 'Show reference 1 of 1 from accessible source',
    })
    await userEvent.click(button)
    expect(renderedSnippetCount(view.container)).toBe(1)
    expect(document.activeElement).toBe(
      view.getByLabelText('Reference 1 of 1 from accessible source'),
    )
    expect(view.queryByRole('button', { name: /Reference shown/ })).toBeNull()
  })

  it('reuses measured placeholder height after a collapse or remount', () => {
    installObservationEnvironment()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(0, 84))
    const first = render(snippetList('measured', 1))

    act(() => preloadObserver().notify())
    act(() => flushNextFrame())
    expect(renderedSnippetCount(first.container)).toBe(1)
    first.unmount()

    const reopened = render(snippetList('measured', 1))
    const placeholder = reopened.getByRole('button', { name: /Show reference/ })
    expect(placeholder.parentElement?.style.height).toBe('84px')
  })

  it('cancels pending work when the list collapses or unmounts', () => {
    installObservationEnvironment()
    const view = render(snippetList('cleanup', 3))
    act(() => preloadObserver().notify())
    expect(scheduledFrames.size).toBe(1)
    view.unmount()
    expect(scheduledFrames.size).toBe(0)
  })

  it('renders every snippet when viewport observation is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const view = render(snippetList('fallback', 7))
    expect(renderedSnippetCount(view.container)).toBe(7)
  })

  it('prioritizes a visible reference over an earlier preload candidate', () => {
    installObservationEnvironment()
    const view = render(snippetList('priority', 2))
    const placeholders = view.getAllByRole('button', { name: /Show reference/ })
    vi.spyOn(placeholders[0]!, 'getBoundingClientRect').mockImplementation(() => rect(-500))
    vi.spyOn(placeholders[1]!, 'getBoundingClientRect').mockImplementation(() => rect(100))

    act(() => preloadObserver().notify())
    act(() => flushNextFrame())
    expect(view.queryByText('priority 0')).toBeNull()
    expect(view.getByText('priority 1')).toBeDefined()
  })

  it('invalidates a measured height when the snippet text changes', () => {
    installObservationEnvironment()
    const getBounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => rect(0, 84))
    const original: BacklinkSnippetData = { key: 'changed-key', text: 'old text', tasks: [] }
    const first = render(
      <BacklinkSnippetList
        snippets={[original]}
        notePath="notes/changed.md"
        sourceTitle="Changed source"
        className="space-y-1"
        onWikilinkClick={() => {}}
        resolveImageUrl={() => undefined}
      />,
    )
    act(() => preloadObserver().notify())
    act(() => flushNextFrame())
    first.unmount()
    getBounds.mockRestore()

    const changed = render(
      <BacklinkSnippetList
        snippets={[{ ...original, text: 'one\ntwo\nthree' }]}
        notePath="notes/changed.md"
        sourceTitle="Changed source"
        className="space-y-1"
        onWikilinkClick={() => {}}
        resolveImageUrl={() => undefined}
      />,
    )
    const placeholder = changed.getByRole('button', { name: /Show reference/ })
    expect(placeholder.parentElement?.style.height).toBe('60px')
  })

  it('re-estimates an unrendered placeholder when its container width changes', () => {
    installObservationEnvironment()
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const longSnippet: BacklinkSnippetData = {
      key: 'resized-key',
      text: 'x'.repeat(80),
      tasks: [],
    }
    const view = render(
      <BacklinkSnippetList
        snippets={[longSnippet]}
        notePath="notes/resized.md"
        sourceTitle="Resized source"
        className="space-y-1"
        onWikilinkClick={() => {}}
        resolveImageUrl={() => undefined}
      />,
    )
    const placeholder = view.getByRole('button', { name: /Show reference/ })
    const container = placeholder.parentElement
    if (container === null) {
      throw new Error('expected a placeholder container')
    }
    let width = 140
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => rect(0, 20, 0, width))
    const observer = resizeObserverInstances.at(-1)
    if (observer === undefined) {
      throw new Error('expected a ResizeObserver')
    }

    act(() => observer.notify())
    expect(container.style.height).toBe('80px')

    width = 350
    act(() => observer.notify())
    expect(container.style.height).toBe('40px')
  })

  it('resumes deferred rendering when an inert mobile layer becomes active', async () => {
    installObservationEnvironment()
    const view = render(
      <div data-testid="layer" inert>
        {snippetList('activation', 1)}
      </div>,
    )
    act(() => preloadObserver().notify())
    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(0)
    expect(scheduledFrames.size).toBe(0)

    view.getByTestId('layer').removeAttribute('inert')
    await waitFor(() => expect(scheduledFrames.size).toBe(1))
    act(() => flushNextFrame())
    expect(renderedSnippetCount(view.container)).toBe(1)
  })
})
