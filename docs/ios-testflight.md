# iOS TestFlight Builds

How to build Reflect's Tauri iOS target and upload it to TestFlight.

```bash
pnpm release:ios preflight
pnpm release:ios build --build-number="$(date -u +%Y%m%d%H%M)"
pnpm release:ios testflight --wait
```

The helper lives at `apps/desktop/scripts/release-ios.mjs` and is exposed as
`pnpm release:ios` from the repo root. `pnpm release:testflight` is a shorthand
for `pnpm release:ios testflight`.

## What You Need

1. **An App Store Connect app for `app.reflect.ios`.** The iOS template already
   sets `PRODUCT_BUNDLE_IDENTIFIER` to `app.reflect.ios` and `DEVELOPMENT_TEAM`
   to `789ULN5MZB`. This is intentionally separate from the old Capacitor mobile
   app (`app.reflect.ReflectMobile`), so TestFlight uploads from this repo do not
   replace the existing mobile app record. The release helper verifies the IPA
   bundle identifier before upload.

   The same iOS template sets `ITSAppUsesNonExemptEncryption` to `false`.
   Reflect iOS currently uses only exempt encryption (standard HTTPS/Git
   transport and OS keychain storage), so App Store Connect can skip the
   repeated export-compliance questionnaire on later builds. If the mobile app
   grows non-exempt cryptography, update the Info.plist value and the App Store
   Connect encryption answers before uploading.

2. **Signing access for `app.reflect.ios`.** For local builds, signing into Xcode
   with a team account that can provision `app.reflect.ios` is enough for
   `pnpm release:ios build`. For CI, use an App Store Connect API key with
   permission to manage signing and upload builds. When the API key is present,
   the release helper exposes it to Tauri/xcodebuild through environment
   variables and uses it directly for altool upload:

   ```bash
   export APPLE_API_KEY=ABC123DEFG
   export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
   export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_ABC123DEFG.p8"
   ```

   In CI, use `APPLE_API_KEY_CONTENT` instead of a path; the script writes it to
   a temporary file outside the workspace. `APPLE_API_KEY_CONTENT` may be the raw
   `.p8` file contents or base64-wrapped text.

3. **Upload credentials.** `pnpm release:ios testflight`, `upload`, and
   `validate` call `xcrun altool`, which still needs explicit authentication
   even when Xcode is signed in. Prefer the App Store Connect API key above.
   Upload-only commands can also use:

   ```bash
   export APPLE_ID=release@example.com
   export APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

   `APPLE_PASSWORD` must be an app-specific password, not the Apple ID's normal
   password. Locally, the helper also reuses the `reflect-notary` keychain item
   created by `pnpm release:macos setup`, passing the stored password to altool
   through `@env:APPLE_PASSWORD`.

4. **Sentry exception telemetry credentials.** Set the public `VITE_SENTRY_DSN` and the
   private, build-only `SENTRY_AUTH_TOKEN` for local TestFlight builds. Configure them in
   GitHub as the repository secrets `SENTRY_DSN` and `SENTRY_AUTH_TOKEN`; the TestFlight
   workflow requires both before building. The token needs release/source-map upload
   scope only and must never use the `VITE_` prefix or enter the app bundle.

5. **A monotonically increasing build number.** TestFlight rejects duplicate
   `CFBundleVersion` values for the same marketing version. The GitHub Action
   always generates a UTC timestamp in `YYYYMMDDHHmm` format. Local `preflight`
   and `testflight` commands generate the same timestamp when `--build-number`
   and `BUILD_NUMBER` are omitted. `--build-number=<number>` exists only as a
   local debugging override. Do not use `github.run_number` for TestFlight
   builds: a lower `CFBundleVersion` can upload successfully while TestFlight
   still appears to show the previous timestamp build as the latest.

5. **Xcode on macOS.** The workflow and local script use `xcodebuild`, Tauri's
   iOS build command, and `xcrun altool`.

## Commands

```bash
pnpm release:ios preflight
```

Checks Xcode/altool, the build number, signing auth, and upload auth before
spending time on the native archive. It also verifies that App Store Connect has
a separate app record for `app.reflect.ios`.

```bash
pnpm release:ios build --build-number="$(date -u +%Y%m%d%H%M)"
```

Runs `pnpm tauri ios build --export-method app-store-connect --ci`, using the
signed-in Xcode account locally or the App Store Connect API key environment
when the key is configured. The build number is merged into the Tauri config as
`bundle.iOS.bundleVersion`. The IPA lands under
`apps/desktop/src-tauri/gen/apple/build/`.

```bash
pnpm release:ios testflight --wait
```

Builds the IPA, uploads it with `xcrun altool --upload-package`, and optionally
waits for App Store Connect processing to finish. If `--build-number` and
`BUILD_NUMBER` are both omitted, the helper generates a UTC timestamp build
number before archiving.

```bash
pnpm release:ios upload --ipa=apps/desktop/src-tauri/gen/apple/build/arm64/Reflect.ipa --wait
pnpm release:ios validate --ipa=apps/desktop/src-tauri/gen/apple/build/arm64/Reflect.ipa
```

Uploads or validates an existing IPA. These commands support `APPLE_ID` +
`APPLE_PASSWORD` (app-specific password), or the local `reflect-notary`
keychain item, as a fallback to the API key.

Pass `--export-method=release-testing` if App Store Connect or Xcode starts
requiring the TestFlight-specific export method. The default remains
`app-store-connect`, matching Tauri's App Store Connect distribution docs and
the upload flow.

## GitHub Action

Use **Actions -> TestFlight -> Run workflow**. The workflow builds on
`macos-26`, uploads the IPA to App Store Connect, and serializes runs so two
uploads do not race each other.

Configure these repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer UUID |
| `APPLE_API_KEY_CONTENT` | Contents of `AuthKey_<KEY>.p8` |

The workflow does not accept a build-number input. Each run resolves one UTC
timestamp build number, logs it, and passes the same value to both `preflight`
and `testflight`. If you need a one-off custom value while debugging, run the
local package command with `--build-number=<number>` instead of changing the
workflow.

## Troubleshooting

- **`exportArchive No Accounts`** or **`No profiles for 'app.reflect.ios' were
  found`**: xcodebuild could not provision the App Store build. Sign into Xcode
  with a team account that can create an App Store provisioning profile for
  `app.reflect.ios`, or set the App Store Connect API key env vars.
- **`Cannot determine the Apple ID from Bundle ID 'app.reflect.ios'`**: the
  bundle id exists for signing, but no App Store Connect app record exists yet.
  Create a new iOS app in App Store Connect for `app.reflect.ios`; do not reuse
  the old Capacitor app record (`app.reflect.ReflectMobile`).
- **`Automatic signing cannot register bundle identifier "app.reflect.ios.<ext>"`**
  (with **`No profiles for 'app.reflect.ios.<ext>' were found`**): a NEW app
  extension target (ShareExtension, RecordingWidget, …) is shipping for the
  first time and its bundle identifier does not exist on the developer portal
  yet. The CI App Store Connect key can create provisioning profiles for
  *existing* identifiers but cannot *register* new ones. Register it once from
  a machine whose Xcode is signed into the team — a signed build of just that
  target auto-registers the identifier and its capabilities (App Group
  included):

  ```bash
  cd apps/desktop/src-tauri/gen/apple
  xcodebuild -project reflect-open.xcodeproj -target <NewExtension> \
    -sdk iphoneos -configuration release -allowProvisioningUpdates build
  ```

  Then rerun the TestFlight workflow. (Registering the identifier by hand in
  the developer portal — with its App Groups capability — works too.)
- **Duplicate build number**: rerun the GitHub Action so it stamps a fresh
  timestamp. For local debugging commands, pass a larger `--build-number`.
  TestFlight build numbers are per marketing version; `0.4.0` build `123` can
  only be uploaded once.
- **TestFlight still shows an older build as latest**: inspect the GitHub Action
  log for `bundle-version`. If the uploaded value is lower than the latest
  TestFlight build (for example a small GitHub run number), rerun the workflow
  so it stamps a fresh timestamp.
- **Missing `.p8` file**: set `APPLE_API_KEY_CONTENT`, set `APPLE_API_KEY_PATH`,
  or place `AuthKey_<KEY>.p8` in `~/.appstoreconnect/private_keys/`.
- **Multiple providers**: if using the Apple ID fallback for upload-only
  commands, set `APPLE_PROVIDER_PUBLIC_ID`.
- **Export-compliance prompt appears again**: rebuild from an Xcode project that
  includes `ITSAppUsesNonExemptEncryption=false` in the iOS Info.plist. The
  release helper refuses to upload IPAs that are missing this key.
