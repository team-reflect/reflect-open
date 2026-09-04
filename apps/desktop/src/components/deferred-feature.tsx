/* eslint-disable @eslint-react/static-components -- The lazy identity is shared across visits and only replaced by an explicit retry, never by a render. */
import { lazy, Suspense, useState, type ComponentType, type ReactElement } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { Button } from '@/components/ui/button'

interface DeferredFeatureOptions {
  /** The feature name used when loading fails. */
  name: string
}

/**
 * Declare a feature at module scope without loading its implementation until
 * it renders. Successful loads are shared across visits; retry replaces the
 * lazy component because React otherwise keeps a rejected import forever.
 * Keep durable feature state and modal shells outside this boundary.
 */
export function createDeferredFeature<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  { name }: DeferredFeatureOptions,
): ComponentType<Props> {
  const shared = { component: lazy(load) }

  return function DeferredFeature(props: Props): ReactElement {
    const [Feature, setFeature] = useState(() => shared.component)

    return (
      <ErrorBoundary
        onReset={() => {
          shared.component = lazy(load)
          setFeature(() => shared.component)
        }}
        fallbackRender={({ resetErrorBoundary }) => (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
            <p role="alert" className="text-text-muted">
              Couldn’t load {name}.
            </p>
            <Button variant="outline" onClick={resetErrorBoundary}>
              Try again
            </Button>
          </div>
        )}
      >
        <Suspense
          fallback={
            <div
              role="status"
              className="flex h-full items-center justify-center p-6 text-sm text-text-muted"
            >
              Loading…
            </div>
          }
        >
          <Feature {...props} />
        </Suspense>
      </ErrorBoundary>
    )
  }
}
