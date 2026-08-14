# tauri-plugin-app-store

Reports which channel installed this build via StoreKit 2's `AppTransaction`:
`Production` (App Store), `Sandbox` (TestFlight or a development install), or
`Xcode` (a StoreKit-configuration run). iOS only; everywhere else the answer
is the fail-closed `Production`.
