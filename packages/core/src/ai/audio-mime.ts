/**
 * Audio MIME-type mapping shared by everything that names a recording: the
 * on-disk storage of captured memos (`actions/audio-memo`), provider upload
 * filenames (`ai/transcribe`), and the Files API content-type header
 * (`ai/gemini-files`). One map, so a stored recording always round-trips
 * back into transcription under a type the providers recognize.
 */

/** `audio/webm;codecs=opus` → `audio/webm` — parameters confuse provider sniffing. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase()
}

/**
 * File extension per audio MIME type. The storage naming and the provider
 * upload filename must agree; extensions matter because some providers sniff
 * by name, not content.
 */
export const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  // An audio-only MP4 *is* an M4A — and whisper-1 sniffs by extension, so a
  // WKWebView recording named `.mp4` is rejected while `.m4a` is accepted.
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}
