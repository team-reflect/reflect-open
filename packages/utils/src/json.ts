/**
 * `JSON.parse(text)`, or undefined when the text is not valid JSON. The
 * platform throws on malformed input; callers that treat bad JSON as an
 * ordinary outcome want an undefined instead. JSON has no `undefined`, so it
 * never collides with a parsed value.
 */
export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
