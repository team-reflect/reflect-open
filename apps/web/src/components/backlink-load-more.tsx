import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { cn } from '@/lib/utils.ts'

const PRELOAD_MARGIN = '600px 0px'

interface BacklinkLoadMoreProps {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  loadMore: () => void
  className?: string
  buttonClassName?: string
}

/**
 * Fetch the next backlinks page shortly before its button reaches the
 * viewport. The button remains a keyboard and no-IntersectionObserver
 * fallback, and becomes the explicit retry control after a page error.
 */
export function BacklinkLoadMore({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  loadMore,
  className,
  buttonClassName,
}: BacklinkLoadMoreProps): ReactElement | null {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const requestPendingRef = useRef(false)

  useEffect(() => {
    if (!isFetchingNextPage) {
      requestPendingRef.current = false
    }
  }, [isFetchingNextPage])

  const requestLoadMore = useCallback(() => {
    if (requestPendingRef.current || isFetchingNextPage) {
      return
    }
    requestPendingRef.current = true
    loadMore()
  }, [isFetchingNextPage, loadMore])

  useEffect(() => {
    const target = buttonRef.current
    if (
      target === null ||
      !hasNextPage ||
      isFetchingNextPage ||
      isFetchNextPageError ||
      requestPendingRef.current ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return
        }
        observer.disconnect()
        requestLoadMore()
      },
      { rootMargin: PRELOAD_MARGIN },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, requestLoadMore])

  if (!hasNextPage) {
    return null
  }

  return (
    <div className={cn('flex flex-col items-start gap-1', className)}>
      {isFetchNextPageError ? (
        <p role="alert" className="text-xs text-text-muted">
          Couldn’t load more backlinks.
        </p>
      ) : null}
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="xs"
        disabled={isFetchingNextPage}
        className={cn('text-text-muted', buttonClassName)}
        onClick={requestLoadMore}
      >
        {isFetchingNextPage ? <Spinner /> : null}
        {isFetchingNextPage
          ? 'Loading more backlinks…'
          : isFetchNextPageError
            ? 'Retry loading backlinks'
            : 'Load more backlinks'}
      </Button>
    </div>
  )
}
