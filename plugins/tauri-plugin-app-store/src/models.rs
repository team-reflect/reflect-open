use serde::{Deserialize, Serialize};

/// Which channel installed this build, as StoreKit 2's
/// `AppTransaction.environment` reports it: `Production` (App Store),
/// `Sandbox` (TestFlight or a development install), or `Xcode` (a
/// StoreKit-configuration run). A probe that cannot answer returns an error
/// instead of a channel.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppStoreEnvironment {
    pub environment: String,
}
