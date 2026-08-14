use serde::{Deserialize, Serialize};

/// Which channel installed this build, as StoreKit 2's
/// `AppTransaction.environment` reports it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStoreEnvironment {
    /// `Production` (App Store), `Sandbox` (TestFlight or a development
    /// install), or `Xcode` (a StoreKit-configuration run). Consumers must
    /// treat unknown values as `Production`: the field passes through
    /// whatever StoreKit reports, and failing closed is what keeps a paying
    /// customer from being misclassified.
    pub environment: String,
}
