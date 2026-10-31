/**
 * Test doubles for `@reflect/app` services, and `createTestAppServices()`, the
 * app layer built over `createTestCoreServices()`.
 */
export {
  createTestNativeMenuHost,
  createTestNativeMenuService,
  type TestNativeMenuHost,
  type TestNativeMenuHostCall,
  type TestNativeMenuService,
  type TestNativeMenuServiceOptions,
} from './commands.ts'
export { createTestClipboardService, type TestClipboardService } from './clipboard.ts'
export {
  createTestOperationsService,
  type OperationSnapshot,
  type TestOperationsService,
} from './operations.ts'
export { createTestOpenerService, type TestOpenerService } from './opener.ts'
export { createTestAppHost, createTestAppServices, type TestAppServices } from './services.ts'
export {
  createTestLifecycleService,
  type TestLifecycleService,
  type TestLifecycleServiceOptions,
} from './lifecycle.ts'
export {
  createTestUpdateService,
  createTestUpdaterAdapter,
  type TestUpdateCall,
  type TestUpdaterAdapter,
  type TestUpdaterCall,
  type TestUpdaterOptions,
  type TestUpdateService,
} from './update.ts'
export {
  createTestNavigationService,
  type TestNavigateCall,
  type TestNavigationService,
  type TestNavigationServiceOptions,
} from './navigation.ts'
export {
  createTestWindowService,
  type TestWindowService,
  type TestWindowServiceOptions,
} from './window.ts'
export { createTestDialogService, type DialogCall, type TestDialogService } from './dialog.ts'
export {
  createTestMobileOnboardingService,
  type TestMobileOnboardingService,
  type TestMobileOnboardingServiceOptions,
} from './mobile-onboarding.ts'
