declare const cloudSafeBrand: unique symbol

/**
 * Proof that a value passed the privacy gate in `privacy-service.ts`. The brand is
 * compile-time only (it serializes as plain JSON); its job is making
 * "checked for privacy" a type every outbound boundary can demand.
 */
export type CloudSafe<T> = T & { readonly [cloudSafeBrand]: true }
