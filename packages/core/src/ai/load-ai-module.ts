import { ReflectError } from '../errors'

/** Load an AI implementation, preserving the retryable error contract for background work. */
export async function loadAiModule<Module>(load: () => Promise<Module>): Promise<Module> {
  try {
    return await load()
  } catch (cause) {
    const error = new ReflectError('network', 'Could not load AI components. Please try again.')
    error.cause = cause
    throw error
  }
}
