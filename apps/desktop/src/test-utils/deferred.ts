export interface Deferred<T> {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let rejectPromise = (_error: Error): void => {}
  let resolvePromise = (_value: T): void => {}
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject
    resolvePromise = resolve
  })
  return { promise, reject: rejectPromise, resolve: resolvePromise }
}
