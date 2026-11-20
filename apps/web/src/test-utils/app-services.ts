import type { AppCommandId, CommandContext } from '@reflect/app'
import { createTestAppServices, type TestAppServices } from '@reflect/app/testing'

/**
 * The test app services, typed with the app's commands.
 */
export type WebTestAppServices = TestAppServices<AppCommandId, CommandContext>

/**
 * `createTestAppServices`, typed with the app's commands.
 */
export const createWebTestAppServices = createTestAppServices<AppCommandId, CommandContext>
