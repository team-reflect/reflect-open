import { ReflectError } from '../errors'

/** A load failure is reported as a retryable network error. */
export async function loadAiModule<Module>(load: () => Promise<Module>): Promise<Module> {
  try {
    return await load()
  } catch (cause) {
    const error = new ReflectError('network', 'Could not load AI components. Please try again.')
    error.cause = cause
    throw error
  }
}
