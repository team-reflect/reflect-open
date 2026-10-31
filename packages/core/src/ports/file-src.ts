/**
 * Maps a file path to the webview URL serving it through a custom URI scheme.
 */
export type FileSrcConverter = (filePath: string, protocol: string) => string

/**
 * Where a service turns a file path into the webview URL that serves it.
 */
export interface FileSrcSource {
  /**
   * The webview URL that serves `filePath` through the custom URI scheme
   * `protocol`, such as `reflect-asset`.
   */
  convertFileSrc(filePath: string, protocol: string): string
}

/**
 * The custom-scheme URL shape Tauri uses on macOS and iOS.
 */
export function appleFileSrc(filePath: string, protocol: string): string {
  return `${protocol}://localhost/${encodeURIComponent(filePath)}`
}
