import type { GraphSessionService } from '@reflect/core'
import type { GraphBootService } from '../graph/graph-boot-service.ts'
import type { GraphSwitchPosition } from './app-commands.ts'

/**
 * Open the recent graph at `position`, unless it is the open one.
 */
export async function switchToRecentGraph(
  graphSession: Pick<GraphSessionService, 'get'>,
  graphBoot: GraphBootService,
  position: GraphSwitchPosition,
): Promise<void> {
  const { recents, graph } = graphSession.get()
  const recent = recents[position - 1]
  if (recent === undefined || recent.root === graph?.root) {
    return
  }
  await graphBoot.openRecent(recent.root)
}
