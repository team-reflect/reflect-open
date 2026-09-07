/**
 * A searchable character is a Unicode letter or digit: `\p{L}` spans every
 * script (`a`, `東`, `こ`, `한`, `٣`), and `\p{N}` covers digits. Everything a
 * writer types that is neither, such as punctuation and emoji, is deliberately
 * out: this is a test for text that a tokenizer would turn into a term, not a
 * test for whether a human sees something.
 */
const SEARCHABLE_CHAR_RE = /[\p{L}\p{N}]/u

/**
 * Whether `text` holds anything a full-text index could tokenize into a term.
 *
 * Bare Markdown scaffolding has nothing: `+ [ ] `, `> `, `---` and `| |` are
 * built from punctuation (`-`, `*`, `#`, `[`) and math symbols (`+`, `>`, `|`,
 * `` ` ``), so they all answer false. A body that only references something,
 * an alt-less image or a bare URL, answers true, because the path or host
 * carries letters even though the note renders no text of its own.
 */
export function hasSearchableChar(text: string): boolean {
  return SEARCHABLE_CHAR_RE.test(text)
}
