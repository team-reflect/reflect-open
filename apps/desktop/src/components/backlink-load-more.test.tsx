import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BacklinkLoadMore } from './backlink-load-more'

const observerInstances: TestIntersectionObserver[] = []

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

  notify(isIntersecting: boolean, times = 1): void {
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
    for (let index = 0; index < times; index += 1) {
      this.callback(entries, this)
    }
  }
}

function installIntersectionObserver(): void {
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
}

function activeObserver(): TestIntersectionObserver {
  const observer = observerInstances.at(-1)
  if (observer === undefined) {
    throw new Error('expected an IntersectionObserver')
  }
  return observer
}

afterEach(() => {
  observerInstances.length = 0
  vi.unstubAllGlobals()
})

describe('BacklinkLoadMore', () => {
  it('defers loading until its 600px preload area and requests only once', async () => {
    installIntersectionObserver()
    const loadMore = vi.fn()
    await render(
      <BacklinkLoadMore
        hasNextPage
        isFetchingNextPage={false}
        isFetchNextPageError={false}
        loadMore={loadMore}
      />,
    )

    expect(loadMore).not.toHaveBeenCalled()
    expect(activeObserver().rootMargin).toBe('600px 0px')

    activeObserver().notify(false)
    expect(loadMore).not.toHaveBeenCalled()

    activeObserver().notify(true, 2)
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('keeps loaded content on a page error and retries only on demand', async () => {
    installIntersectionObserver()
    const loadMore = vi.fn()
    const view = await render(
      <>
        <p>Already loaded reference</p>
        <BacklinkLoadMore
          hasNextPage
          isFetchingNextPage={false}
          isFetchNextPageError
          loadMore={loadMore}
        />
      </>,
    )

    await expect.element(view.getByText('Already loaded reference')).toBeInTheDocument()
    expect(view.getByRole('alert').element().textContent).toContain('Couldn’t load more backlinks.')
    expect(observerInstances).toHaveLength(0)

    await userEvent.click(view.getByRole('button', { name: 'Retry loading backlinks' }))
    expect(loadMore).toHaveBeenCalledTimes(1)
    await expect.element(view.getByText('Already loaded reference')).toBeInTheDocument()
  })

  it('does not observe or request another page while a fetch is active', async () => {
    installIntersectionObserver()
    const loadMore = vi.fn()
    const view = await render(
      <BacklinkLoadMore
        hasNextPage
        isFetchingNextPage
        isFetchNextPageError={false}
        loadMore={loadMore}
      />,
    )

    const button = view.getByRole('button', { name: 'Loading more backlinks…' })
    await expect.element(button).toBeDisabled()
    expect(observerInstances).toHaveLength(0)

    await userEvent.click(button, { force: true })
    expect(loadMore).not.toHaveBeenCalled()
  })

  it('keeps a manual load button when viewport observation is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const loadMore = vi.fn()
    const view = await render(
      <BacklinkLoadMore
        hasNextPage
        isFetchingNextPage={false}
        isFetchNextPageError={false}
        loadMore={loadMore}
      />,
    )

    await userEvent.click(view.getByRole('button', { name: 'Load more backlinks' }))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })
})
