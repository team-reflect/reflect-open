/**
 * Allocates until the garbage collector has run a few times and has freed an
 * unreferenced object. Throws if it never does.
 */
export async function collectGarbage(): Promise<void> {
  const probe = new WeakRef({})
  for (let round = 0; round < 30 || probe.deref(); round++) {
    if (round === 300) {
      throw new Error('The garbage collector did not run')
    }
    let junk: object[] | undefined = []
    for (let i = 0; i < 200_000; i++) {
      junk.push({ i })
    }
    junk = undefined
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
