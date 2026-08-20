import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { createDailyDatesQueryOptions } from '@/lib/query-options'
import { useGraph } from '@/providers/graph-provider'

/** Indexed daily-note dates in an inclusive range, ready for calendar lookup. */
export function useDailyNoteDates(start: string, end: string): ReadonlySet<string> {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    ...createDailyDatesQueryOptions(graph?.root, start, end),
    enabled: bridgeReady && graph !== null,
    placeholderData: keepPreviousData,
  })

  return useMemo(() => new Set(data ?? []), [data])
}
