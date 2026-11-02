/**
 * Tears down a subscription: what every `subscribe`, `onXxx` and `listen`
 * returns.
 */
export type Unlisten = () => void
