# iOS TestFlight Builds

```bash
pnpm build:ios --build-number="$(date -u +%Y%m%d%H%M)"   # apps/desktop/scripts/build-ios.ts
pnpm upload:testflight                                   # apps/desktop/scripts/upload-testflight.ts
```

`.github/workflows/publish-testflight.yml` runs both on every release (called from
`publish-desktop.yml`). To retry, re-run its failed job in the Release run.

## Credentials

Local builds read these environment variables. CI sets them from the `release_app`
environment secrets.

- App Store Connect API key: `APPLE_API_KEY`, `APPLE_API_ISSUER`, and either `APPLE_API_KEY_PATH`
  or `APPLE_API_KEY_CONTENT` (CI uses the latter).
- Sentry DSN: `VITE_SENTRY_DSN` for the WebView SDK and `REFLECT_SENTRY_DSN` for the native SDK
  (CI: both from `SENTRY_DSN`).
- `SENTRY_AUTH_TOKEN`: dSYM and source map upload. Never give it a `VITE_` prefix.

## Troubleshooting

- **`Automatic signing cannot register bundle identifier "app.reflect.ios.<ext>"`**: a new app
  extension ships for the first time, and the CI key cannot register identifiers. Register it
  once from a Mac signed into the team, then rerun the workflow:

  ```bash
  cd apps/desktop/src-tauri/gen/apple
  xcodebuild -project reflect-open.xcodeproj -target <NewExtension> \
    -sdk iphoneos -configuration release -allowProvisioningUpdates build
  ```

- **`Cannot determine the Apple ID from Bundle ID 'app.reflect.ios'`**: create the App Store
  Connect app record for `app.reflect.ios`. Do not reuse the old Capacitor app
  (`app.reflect.ReflectMobile`).
- **Duplicate build number, or TestFlight shows an older build as latest**: build numbers must
  increase per marketing version. CI uses a UTC `YYYYMMDDHHmm` timestamp; rerun the workflow.
- **A TestFlight feedback ZIP has no stack**: expected. Read the native events in Sentry, or ask
  for the Apple `.ips` report.
- **An `.ips` report is unsymbolicated**: symbolicate it against the dSYM in the
  `reflect-ios-xcarchive-<build>` artifact of that build. The IPA has no dSYM.
