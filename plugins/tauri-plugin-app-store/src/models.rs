use serde::{Deserialize, Serialize};

/// Which channel installed this build, as StoreKit 2's
/// `AppTransaction.environment` reports it: `Production` (App Store),
/// `Sandbox` (TestFlight or a development install), or `Xcode` (a
/// StoreKit-configuration run). Consumers must treat unknown values as
/// `Production`, the fail-closed answer.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppStoreEnvironment {
    pub environment: String,
}
