import { collectPostEmbeds } from '@meowdown/core'
import { sleep } from '@ocavue/utils'
import { useEffect, useMemo, useState } from 'react'
import { getXPostResolver, isXPostResolved } from '@/editor/use-x-post-resolver'
import { useGraph } from '@/providers/graph-provider'

// Longest wait before mounting anyway; cold-start archive reads measured up to 258 ms.
const PRELOAD_BUDGET_MS = 300

/**
 * Whether an editor mounted now for `markdown` renders its X post cards in the
 * first frame: every post is resolved, or the wait ran out. `null` means there
 * is no editor content yet.
 */
export function useXPostPreload(markdown: string | null): boolean {
  const graph = useGraph({ optional: true })?.graph ?? null
  const urls = useMemo(
    () =>
      markdown === null
        ? []
        : collectPostEmbeds(markdown)
            .filter((embed) => embed.kind === 'x-post')
            .map((embed) => embed.url),
    [markdown],
  )
  const resolved = urls.every((url) => isXPostResolved(graph, url))
  const [settledFor, setSettledFor] = useState<string | null>(null)

  useEffect(() => {
    if (markdown === null || resolved) return
    let active = true
    const resolveXPost = getXPostResolver(graph)
    const reads = urls.map(async (url) => await resolveXPost(url))
    void Promise.race([Promise.allSettled(reads), sleep(PRELOAD_BUDGET_MS)]).then(() => {
      if (active) setSettledFor(markdown)
    })
    return () => {
      active = false
    }
  }, [markdown, urls, resolved, graph])

  return markdown !== null && (resolved || settledFor === markdown)
}
