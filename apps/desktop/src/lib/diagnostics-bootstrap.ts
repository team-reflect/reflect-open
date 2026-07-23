import {
  bootstrapDiagnostics,
  type DiagnosticsStatus,
} from '@reflect/core'

export const NORMAL_DIAGNOSTICS_STATUS: DiagnosticsStatus = {
  safeMode: false,
  reason: null,
  recentWebContentTerminations: 0,
}

/**
 * Reads iOS recovery state before the ordinary provider tree mounts. A
 * diagnostics failure must fail open: losing the journal must never prevent
 * the user from opening their notes.
 */
export async function resolveDiagnosticsStartup(
  enabled: boolean,
  bootstrap: () => Promise<DiagnosticsStatus> = bootstrapDiagnostics,
): Promise<DiagnosticsStatus> {
  if (!enabled) {
    return NORMAL_DIAGNOSTICS_STATUS
  }
  try {
    return await bootstrap()
  } catch {
    return NORMAL_DIAGNOSTICS_STATUS
  }
}

/**
 * Starts ordinary platform warming only after the native gate permits it.
 * Keeping this sequencing in one helper makes the “safe mode opens no notes”
 * invariant independently testable.
 */
export async function prepareApplicationStartup(
  enabled: boolean,
  warm: () => void,
  bootstrap: () => Promise<DiagnosticsStatus> = bootstrapDiagnostics,
): Promise<DiagnosticsStatus> {
  const status = await resolveDiagnosticsStartup(enabled, bootstrap)
  if (!status.safeMode) {
    warm()
  }
  return status
}
