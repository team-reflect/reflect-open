import { z } from 'zod'
import { call } from '../ipc/invoke'

const agentSkillInstallStateSchema = z.enum(['missing', 'current', 'stale', 'conflict'])

/**
 * Where the installed skill file stands relative to what the app would write
 * today: `missing` (no file), `current` (byte-identical), `stale` (ours, but
 * rendered from older inputs — safe to rewrite), or `conflict` (a file the
 * app doesn't manage; never overwritten or deleted).
 */
export type AgentSkillInstallState = z.infer<typeof agentSkillInstallStateSchema>

const agentSkillStatusSchema = z.object({
  /** The skill's directory name, derived from the graph (`reflect-<slug>`). */
  skillName: z.string(),
  /** Absolute path of the target `SKILL.md` under `~/.agents/skills/`. */
  skillPath: z.string(),
  /** Absolute path of the bundled `reflect` CLI the skill references. */
  cliPath: z.string(),
  installState: agentSkillInstallStateSchema,
})

/** Install status of the open graph's agent skill (Settings → Agents). */
export type AgentSkillStatus = z.infer<typeof agentSkillStatusSchema>

/** The open graph's agent-skill install status. Read-only. */
export async function agentSkillStatus(): Promise<AgentSkillStatus> {
  return call('skill_status', {}, agentSkillStatusSchema)
}

/**
 * Write (or refresh) the open graph's `SKILL.md` under `~/.agents/skills/`.
 * Generation-pinned like every mutating command; rejects `conflict` files.
 */
export async function agentSkillInstall(generation: number): Promise<AgentSkillStatus> {
  return call('skill_install', { generation }, agentSkillStatusSchema)
}

/** Remove the open graph's managed skill file. Rejects `conflict` files. */
export async function agentSkillUninstall(generation: number): Promise<AgentSkillStatus> {
  return call('skill_uninstall', { generation }, agentSkillStatusSchema)
}
