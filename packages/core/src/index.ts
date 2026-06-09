/**
 * `@reflect/core` — the TypeScript business-logic layer.
 *
 * Per the architecture conventions, all reads, orchestration, AI/provider
 * calls, and privacy guards live here; the Rust shell provides only native
 * primitives. The per-domain `actions/` modules land in later plans; this entry
 * point currently exposes the IPC boundary and the shared error contract.
 */
export { call } from './ipc/invoke'
export { getAppVersion } from './ipc/commands'
export { appErrorSchema, isAppError, type AppError } from './errors'
