import { initializeExceptionTelemetry } from '@/lib/exception-telemetry'
import { installTauriBridge } from '@/lib/tauri-bridge'

// Runs before every module imported after this one, so exception telemetry
// and the IPC bridge exist while the rest of the app's modules evaluate.
const reactRootOptions = initializeExceptionTelemetry()
installTauriBridge()

export { reactRootOptions }
