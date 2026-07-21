/**
 * The App Review demo key. App Store reviewers have no BYOK key, so this
 * sentinel (shared with Apple in the App Review notes; not a secret) makes
 * the app behave as if a real key was entered while never touching the
 * network. Exactly two places consult it: `validateApiKey` accepts it without
 * probing the provider (a real probe would 401 and block saving it), and
 * `buildAudioMemoTranscript` in `ai/audio-memo-transcript` returns a canned
 * local transcript instead of calling any provider. Capture and note plumbing
 * run exactly as in production.
 */
export const APP_REVIEW_STUB_KEY = 'sk-demo'

export function stubTranscriptBody(): string {
  return (
    "This is a demo transcription produced by Reflect's App Review demo key. " +
    'No audio left the device and no AI provider was called.\n\n' +
    `Demo transcript generated at ${new Date().toLocaleString()}.`
  )
}
