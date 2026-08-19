/** Capability granted to one chat turn when the user presses Send. */
export type ChatPermissionMode = 'read' | 'readWrite'

/** The least-privileged mode used for every new, restored, or reopened chat. */
export const DEFAULT_CHAT_PERMISSION_MODE: ChatPermissionMode = 'read'
