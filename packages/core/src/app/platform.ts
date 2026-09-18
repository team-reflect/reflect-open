/** Which UI family the app was built for. */
export type AppPlatform = 'desktop' | 'ios' | 'android'

/** Narrows {@link AppPlatform} to the mobile family. */
export function isMobilePlatform(platform: AppPlatform): boolean {
  return platform !== 'desktop'
}
