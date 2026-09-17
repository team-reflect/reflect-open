import { collectImages, parseXPostId } from '@meowdown/markdown'
import { sleep } from '@ocavue/utils'
import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { xPostQueryOptions } from '@/editor/use-x-post-resolver'
import { queryClient } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

// Longest wait before mounting anyway; cold-start archive reads measured up to 258 ms.
const PRELOAD_BUDGET_MS = 300

/**
 * Whether an editor mounted now for `markdown` renders its X post cards in the
 * first frame: every post is loaded, or the wait ran out. `null` means there
 * is no editor content yet.
 */
export function useXPostPreload(markdown: string | null): boolean {
  const generation = useGraph({ optional: true })?.graph?.generation ?? null
  const queries = useMemo(() => {
    if (markdown === null || generation === null) return []
    const ids = new Set<string>()
    for (const url of collectImages(markdown)) {
      const id = parseXPostId(url)
      if (id) ids.add(id)
    }
    return [...ids].map((id) => xPostQueryOptions(generation, id))
  }, [markdown, generation])
  // The resolver reads the shared client, so the preload must fill that one.
  const loaded = useQueries(
    {
      queries,
      combine: (results) => results.every((result) => !result.isPending),
    },
    queryClient,
  )
  const [expiredFor, setExpiredFor] = useState<string | null>(null)

  useEffect(() => {
    if (markdown === null || loaded) return
    let active = true
    void sleep(PRELOAD_BUDGET_MS).then(() => {
      if (active) setExpiredFor(markdown)
    })
    return () => {
      active = false
    }
  }, [markdown, loaded])

  return markdown !== null && (loaded || expiredFor === markdown)
}
