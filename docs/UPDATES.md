# GitHub Release updates

Packaged Rust builds use Tauri's updater with `https://github.com/BoeingART/Mossentry/releases/latest/download/latest.json`. Tauri compares semantic versions against the running application's version, selects the current OS and architecture, and verifies the downloaded package with the public key in `src-tauri/tauri.conf.json`. Signed version binding is required, so the package must also match the announced version. Equal or lower versions keep the button hidden. The workflow marks prerelease tags as prereleases, so they are excluded from the stable endpoint.

Checks run at startup, every ten minutes and on network reconnection. Finding a newer release shows the top-right Update button and immediately downloads the package. Readiness is reported only after signature verification. Clicking the ready button installs and restarts; the Rust service's operation lock prevents installation from interrupting server mutations. A failed download retries on the next check or button click. A failed installation requires a click to retry. Downloads are retained in the Rust process until installation or exit, and are downloaded again after a restart. Development executables and the standalone browser preview never apply updates.

## One-time signing setup

The matching signing key was generated locally outside the repository at `~/.config/Mossentry/updater-signing/mossentry.key`. Its public key is committed in the Tauri configuration. The private key is passwordless, has owner-only permissions, and must be backed up securely. Never commit or upload it as a release asset.

Initial setup on 2026-10-21 configured this key as the repository's GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`. For this passwordless key, leave `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` unset. To provision the same key again from an authenticated maintainer shell:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo BoeingART/Mossentry \
  < ~/.config/Mossentry/updater-signing/mossentry.key
```

The workflow deliberately fails tagged builds if the secret is absent. Pull requests and untagged manual runs build ordinary installers without requiring the secret. Replacing this key after distribution requires a key migration through a release signed by the existing key, or a manual reinstall.

## macOS Developer ID signing and notarization

Tauri updater signatures and Apple code signatures serve separate purposes. The published v0.2.0 through v0.2.2 macOS packages are ad-hoc signed (`signingIdentity: "-"`) and have no Apple notarization ticket. A valid updater signature does not prevent Gatekeeper from blocking a downloaded application. See [INSTALL.md](INSTALL.md#apple-verification-warning--apple-无法验证) for the supported first-launch exception procedure.

macOS releases currently retain ad-hoc signing without Apple notarization. Signed updater packages remain required. Apple signing and notarization are optional: set the repository Actions variable `APPLE_NOTARIZATION=true` only after configuring all Apple credentials below. In that mode both Mac architectures must pass Apple trust verification before publication. Pull requests and untagged manual runs retain ad-hoc signing for development.

To provision a release:

1. Enroll in the regular [Apple Developer Program](https://developer.apple.com/cn/help/account/membership/enrolling-in-the-app/). As checked on 2026-10-22, the mainland China annual membership is ¥688; Apple lists a US$99 annual price in the US. A personal membership is sufficient. Eligible accredited educational institutions, nonprofits and government entities may request a [membership fee waiver](https://developer.apple.com/cn/help/account/membership/fee-waivers/); individual teachers/students and an educational email address alone do not qualify for that waiver. A free personal developer account does not include notarization.
2. On the Mac that will hold the private key, use **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority** to save a certificate signing request (CSR).
3. As the developer team's Account Holder, open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list), create a **Developer ID Application** certificate from that CSR, download the `.cer`, and install it in that Mac's login keychain. This is the certificate for distributing `.app` bundles outside the Mac App Store.
4. In Keychain Access → My Certificates, export the certificate **with its private key** as a password-protected `.p12`. Encode it using `openssl base64 -A -in /path/to/certificate.p12 -out /path/to/certificate-base64.txt`. Keep these private files outside the repository.
5. Create an [app-specific Apple Account password](https://support.apple.com/en-us/102654) for notarization. Use this password rather than your regular account password.
6. In GitHub → this repository → Settings → Secrets and variables → Actions, configure the following repository secrets, then enable the `APPLE_NOTARIZATION=true` repository variable:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD` | Non-empty password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full identity, e.g. `Developer ID Application: Your Name (TEAMID1234)` |
| `APPLE_ID` | Apple Account email for the developer membership |
| `APPLE_PASSWORD` | App-specific password used by Apple's notarization service |
| `APPLE_TEAM_ID` | Team ID matching the signing identity |

`security find-identity -v -p codesigning` lists installed identities. The workflow passes these secrets to Tauri, which imports the certificate into a temporary keychain, signs with Developer ID and the hardened runtime, submits the app for notarization, and staples the ticket before generating updater packages. `APPLE_SIGNING_IDENTITY` overrides the development ad-hoc identity. Keep the existing `TAURI_SIGNING_PRIVATE_KEY` for updater authentication as well.

Before staging release assets, `scripts/verify-macos-release.sh` checks the built app, the app extracted from the signed updater archive, and the app inside the mounted read-only DMG. Each must have a valid Apple-issued Developer ID Application signature, a valid stapled ticket and an accepted Gatekeeper assessment. The checks do not re-sign packages or remove quarantine attributes. Actual notarization and positive Gatekeeper acceptance must be verified with real credentials; credential preflight tests alone cannot establish either.

For a local release build, export the same Apple variables and the updater key, then run:

```bash
node scripts/release.cjs check-macos-signing
npm run tauri -- build --bundles app,dmg --config src-tauri/tauri.release.conf.json -- --locked
bash scripts/verify-macos-release.sh
```

See the [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) and [Apple Developer ID certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) for the underlying setup.

## Publish an update

1. Set the same new version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`.
2. Provision the updater key before pushing a matching `v<version>` tag. Apple credentials are required only when `APPLE_NOTARIZATION=true`. The workflow tests and builds macOS Apple Silicon, macOS Intel and Windows x64. Tagged builds enable `src-tauri/tauri.release.conf.json`, generating `.app.tar.gz` / `.exe` updater packages and their `.sig` files. When Apple notarization is enabled, the Mac builds must pass Developer ID, notarization-ticket and Gatekeeper checks before publication.
3. The publish job combines all three platforms into one `latest.json`, checks all assets and signatures are present, and publishes the manifest, packages, installers and checksums together. Filenames include architecture so the two Mac packages cannot overwrite each other.

Do not publish a higher-version release containing only DMGs/EXEs. Keep `latest.json` and its signed updater assets together. Tauri's [updater documentation](https://v2.tauri.app/plugin/updater/) describes the manifest and signing format.

For a local signed build, set `TAURI_SIGNING_PRIVATE_KEY` to the private-key file path and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string, then run:

```bash
npm run tauri -- build --config src-tauri/tauri.release.conf.json
```

The first Rust build with this feature still needs to be installed manually by users of the historical Electron release. End-to-end replacement and restart must be exercised using two signed packaged versions on each supported OS; unit tests and build checks do not establish that platform-specific installer behavior.
