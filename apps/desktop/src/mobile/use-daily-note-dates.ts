import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { dailyDatesInRange } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/** Indexed daily-note dates in an inclusive range, ready for calendar lookup. */
export function useDailyNoteDates(start: string, end: string): ReadonlySet<string> {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'dailyDates', start, end],
    queryFn: () => dailyDatesInRange(start, end),
    enabled: bridgeReady && graph !== null,
    placeholderData: keepPreviousData,
  })

  return useMemo(() => new Set(data ?? []), [data])
}
