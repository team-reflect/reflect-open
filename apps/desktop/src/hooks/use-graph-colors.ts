import { useCallback } from 'react'
import type { GraphColor } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'

interface GraphColorsValue {
  /** The color chosen for `root`, or `undefined` if it's on the default. */
  colorFor: (root: string) => GraphColor | undefined
  /** Choose `color` for `root`; applied instantly, persisted with settings. */
  setColor: (root: string, color: GraphColor) => void
}

/**
 * Per-graph identity colors, backed by the `graphColors` settings record
 * (keyed by graph root path). Entries survive a graph being forgotten from
 * recents on purpose — re-opening the graph restores its color.
 */
export function useGraphColors(): GraphColorsValue {
  const { settings, updateSettingsWith } = useSettings()
  const colors = settings.graphColors

  const colorFor = useCallback((root: string) => colors[root], [colors])

  const setColor = useCallback(
    (root: string, color: GraphColor) => {
      // Read-modify-write of a record: compose over the latest settings, not a
      // render-time snapshot (see updateSettingsWith).
      updateSettingsWith((current) => ({
        graphColors: { ...current.graphColors, [root]: color },
      }))
    },
    [updateSettingsWith],
  )

  return { colorFor, setColor }
}
