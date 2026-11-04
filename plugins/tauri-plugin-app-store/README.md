# tauri-plugin-app-store

Reports which channel installed this build via StoreKit 2's `AppTransaction`:
`Production` (App Store), `Sandbox` (TestFlight or a development install), or
`Xcode` (a StoreKit-configuration run). iOS only; everywhere else the answer
is the fail-closed `Production`. Also exposes `AppStore.sync()` so a Restore
Purchases action can refetch transactions from the App Store, and Apple's
in-app offer-code redemption sheet. `request_review` asks for StoreKit's
review prompt; the system decides whether it shows.
