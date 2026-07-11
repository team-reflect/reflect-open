/**
 * The version with any prerelease tag or build metadata stripped:
 * `0.6.0-beta.6` becomes `0.6.0`. Matches how Tauri renders
 * `CFBundleShortVersionString` (Apple allows only three numeric parts), so
 * mobile Settings shows the same version as the App Store listing and a
 * promoted TestFlight build never surfaces `-beta.N` to production users.
 */
export function marketingVersion(version: string): string {
  return version.replace(/[-+].*$/, '')
}
