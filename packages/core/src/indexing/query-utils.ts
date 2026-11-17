/**
 * Bound variables per `IN (…)` clause. SQLite caps variables per statement
 * (999 on older builds), so chunking keeps every statement comfortably inside
 * the budget.
 */
const IN_CLAUSE_LIMIT = 500

/** Split `values` into `IN`-clause-sized chunks (no chunks for no values). */
export function inClauseChunks<Value>(values: readonly Value[]): Value[][] {
  const chunks: Value[][] = []
  for (let start = 0; start < values.length; start += IN_CLAUSE_LIMIT) {
    chunks.push(values.slice(start, start + IN_CLAUSE_LIMIT))
  }
  return chunks
}
