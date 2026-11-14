import type { AgentSkillStatus } from '@reflect/types'
import type { MaybePromise } from '@reflect/utils'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'

export type { AgentSkillInstallState, AgentSkillStatus } from '@reflect/types'

/**
 * Manages the open graph's agent skill file under `~/.agents/skills/`.
 */
export interface AgentSkillService {
  /**
   * The open graph's agent-skill install status. Read-only.
   */
  status(): MaybePromise<AgentSkillStatus>
  /**
   * Write (or refresh) the open graph's `SKILL.md`. Pinned to the open
   * graph's generation like every mutating command; rejects `conflict` files
   * and rejects when no graph is open.
   */
  install(): Promise<AgentSkillStatus>
  /**
   * Remove the open graph's managed skill file. Rejects `conflict` files.
   */
  uninstall(): Promise<AgentSkillStatus>
}

export interface AgentSkillServiceDeps {
  readonly ipc: IpcBridgeService
  readonly graphSession: GraphSessionSource
}

class AgentSkillServiceImpl implements AgentSkillService {
  readonly #deps: AgentSkillServiceDeps

  constructor(deps: AgentSkillServiceDeps) {
    this.#deps = deps
  }

  status(): Promise<AgentSkillStatus> {
    return this.#deps.ipc.call('skill_status', {})
  }

  async install(): Promise<AgentSkillStatus> {
    const { ipc, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return await ipc.call('skill_install', { generation })
  }

  async uninstall(): Promise<AgentSkillStatus> {
    const { ipc, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return await ipc.call('skill_uninstall', { generation })
  }
}

export function createAgentSkillService(deps: AgentSkillServiceDeps): AgentSkillService {
  return new AgentSkillServiceImpl(deps)
}
