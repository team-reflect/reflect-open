import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'

const agentSkillInstallStateSchema = z.enum(['missing', 'current', 'stale', 'conflict'])

/**
 * Where the installed skill file stands relative to what the app would write
 * today: `missing` (no file), `current` (byte-identical), `stale` (ours, but
 * rendered from older inputs, safe to rewrite), or `conflict` (a file the
 * app doesn't manage; never overwritten or deleted).
 */
export type AgentSkillInstallState = z.infer<typeof agentSkillInstallStateSchema>

const agentSkillStatusSchema = z.object({
  /**
   * The skill's directory name, derived from the graph (`reflect-<slug>`).
   */
  skillName: z.string(),
  /**
   * Absolute path of the target `SKILL.md` under `~/.agents/skills/`.
   */
  skillPath: z.string(),
  /**
   * Absolute path of the bundled `reflect` CLI the skill references.
   */
  cliPath: z.string(),
  installState: agentSkillInstallStateSchema,
})

/**
 * Install status of the open graph's agent skill.
 */
export type AgentSkillStatus = z.infer<typeof agentSkillStatusSchema>

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
    return this.#deps.ipc.call('skill_status', {}, agentSkillStatusSchema)
  }

  async install(): Promise<AgentSkillStatus> {
    const { ipc, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return await ipc.call('skill_install', { generation }, agentSkillStatusSchema)
  }

  async uninstall(): Promise<AgentSkillStatus> {
    const { ipc, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return await ipc.call('skill_uninstall', { generation }, agentSkillStatusSchema)
  }
}

export function createAgentSkillService(deps: AgentSkillServiceDeps): AgentSkillService {
  return new AgentSkillServiceImpl(deps)
}
