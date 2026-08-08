import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useRouter } from '@/routing/router'

/**
 * What the resident preview panel should show, or `null` for nothing. A PDF
 * target carries its graph-relative `assets/…` path and the 1-based page it
 * was opened on (if any); a note target previews the note's body.
 */
export type PreviewPanelTarget =
  | { kind: 'pdf'; assetPath: string; page?: number }
  | { kind: 'note'; path: string }

/**
 * The open preview panel's target, driven by editor clicks and deep links and
 * cleared on navigation. Split into separate value/setter contexts so a
 * producer (the editor's link handler) can consume the stable setter without
 * re-rendering every time the target changes — the same shape
 * {@link FocusedDailyProvider} uses.
 */

const PreviewPanelTargetContext = createContext<PreviewPanelTarget | null>(null)
const SetPreviewPanelTargetContext = createContext<(target: PreviewPanelTarget | null) => void>(
  () => {},
)

/** Provides the preview-panel target to the workspace shell and link handlers. */
export function PreviewPanelProvider({ children }: { children: ReactNode }): ReactElement {
  const { route } = useRouter()
  const [target, setTarget] = useState<PreviewPanelTarget | null>(null)
  // The route the current target was opened on. Navigation is a route change,
  // and a target never survives its own route — so the panel closes on
  // navigation as a *derived* value rather than an effect reset (the same
  // "stale on navigation" semantics as the daily-context target, without an
  // effect). The setter records the route it was called under, so it is
  // recreated per route just like any other route-scoped binding.
  const [targetRoute, setTargetRoute] = useState(route)
  const setTargetWithRoute = useCallback(
    (next: PreviewPanelTarget | null) => {
      setTarget(next)
      setTargetRoute(route)
    },
    [route],
  )
  const activeTarget = target !== null && targetRoute === route ? target : null
  return (
    <SetPreviewPanelTargetContext value={setTargetWithRoute}>
      <PreviewPanelTargetContext value={activeTarget}>{children}</PreviewPanelTargetContext>
    </SetPreviewPanelTargetContext>
  )
}

/** The current preview target, or `null` when the panel is closed. */
export function usePreviewPanelTarget(): PreviewPanelTarget | null {
  return use(PreviewPanelTargetContext)
}

/** Open (`null` closes) the preview panel. No-op without a provider. */
export function useSetPreviewPanelTarget(): (target: PreviewPanelTarget | null) => void {
  return use(SetPreviewPanelTargetContext)
}

export interface PreviewPanel {
  /** The current target, or `null` when the panel is closed. */
  target: PreviewPanelTarget | null
  /** Open the panel for `target`. */
  open: (target: PreviewPanelTarget) => void
  /** Close the panel. */
  close: () => void
}

/** The preview panel's target plus its open/close actions. */
export function usePreviewPanel(): PreviewPanel {
  const target = usePreviewPanelTarget()
  const setTarget = useSetPreviewPanelTarget()
  const open = useCallback((next: PreviewPanelTarget) => setTarget(next), [setTarget])
  const close = useCallback(() => setTarget(null), [setTarget])
  return useMemo(() => ({ target, open, close }), [target, open, close])
}
