# iOS TestFlight Builds

How to build Reflect's Tauri iOS target and upload it to TestFlight.

```bash
pnpm release:ios preflight --build-number=123
pnpm release:ios build --build-number=123
pnpm release:ios testflight --build-number=123 --wait
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

4. **A monotonically increasing build number.** TestFlight rejects duplicate
   `CFBundleVersion` values for the same marketing version. Pass
   `--build-number=<number>` locally; the helper injects it as
   `bundle.iOS.bundleVersion` so beta versions still produce a clean numeric
   build version. The GitHub Action defaults this to the workflow run number.

5. **Xcode on macOS.** The workflow and local script use `xcodebuild`, Tauri's
   iOS build command, and `xcrun altool`.

## Commands

```bash
pnpm release:ios preflight --build-number=123
```

Checks Xcode/altool, the build number, signing auth, and upload auth before
spending time on the native archive. It also verifies that App Store Connect has
a separate app record for `app.reflect.ios`.

```bash
pnpm release:ios build --build-number=123
```

Runs `pnpm tauri ios build --export-method app-store-connect --ci`, using the
signed-in Xcode account locally or the App Store Connect API key environment
when the key is configured. The build number is merged into the Tauri config as
`bundle.iOS.bundleVersion`. The IPA lands under
`apps/desktop/src-tauri/gen/apple/build/`.

```bash
pnpm release:ios testflight --build-number=123 --wait
```

Builds the IPA, uploads it with `xcrun altool --upload-package`, and optionally
waits for App Store Connect processing to finish.

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

The workflow's build number defaults to `github.run_number`. Override the input
only when retrying a run that already uploaded a build.

## Troubleshooting

- **`exportArchive No Accounts`** or **`No profiles for 'app.reflect.ios' were
  found`**: xcodebuild could not provision the App Store build. Sign into Xcode
  with a team account that can create an App Store provisioning profile for
  `app.reflect.ios`, or set the App Store Connect API key env vars.
- **`Cannot determine the Apple ID from Bundle ID 'app.reflect.ios'`**: the
  bundle id exists for signing, but no App Store Connect app record exists yet.
  Create a new iOS app in App Store Connect for `app.reflect.ios`; do not reuse
  the old Capacitor app record (`app.reflect.ReflectMobile`).
- **Duplicate build number**: rerun with a larger `--build-number`. TestFlight
  build numbers are per marketing version; `0.4.0` build `123` can only be
  uploaded once.
- **Missing `.p8` file**: set `APPLE_API_KEY_CONTENT`, set `APPLE_API_KEY_PATH`,
  or place `AuthKey_<KEY>.p8` in `~/.appstoreconnect/private_keys/`.
- **Multiple providers**: if using the Apple ID fallback for upload-only
  commands, set `APPLE_PROVIDER_PUBLIC_ID`.
- **Export-compliance prompt appears again**: rebuild from an Xcode project that
  includes `ITSAppUsesNonExemptEncryption=false` in the iOS Info.plist. The
  release helper refuses to upload IPAs that are missing this key.
