import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** The crash fallback, receiving the error message. Defaults to a quiet text block. */
  fallback?: (message: string) => ReactElement
}

interface ErrorBoundaryState {
  message: string | null
}

/**
 * Renders render-phase and effect crashes as readable text instead of a white
 * screen. The desktop shell has no global boundary, so one throw anywhere in a
 * subtree unmounts the whole root — an ErrorBoundary is the fail-loud surface
 * of last resort. Wrap coarse regions (the app, the preview panel), not every
 * component: each boundary is a permanent safety net, not a debugging crutch.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('error boundary caught:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      const fallback = this.props.fallback
      if (fallback !== undefined) {
        return fallback(this.state.message)
      }
      return (
        <div role="alert" className="p-3 text-xs text-text-muted">
          {this.state.message}
        </div>
      )
    }
    return this.props.children
  }
}
