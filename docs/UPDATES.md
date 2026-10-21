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

## Publish an update

1. Set the same new version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`.
2. Push a matching `v<version>` tag. The workflow tests and builds macOS Apple Silicon, macOS Intel and Windows x64. Tagged builds enable `src-tauri/tauri.release.conf.json`, generating `.app.tar.gz` / `.exe` updater packages and their `.sig` files.
3. The publish job combines all three platforms into one `latest.json`, checks all assets and signatures are present, and publishes the manifest, packages, installers and checksums together. Filenames include architecture so the two Mac packages cannot overwrite each other.

Do not publish a higher-version release containing only DMGs/EXEs. Keep `latest.json` and its signed updater assets together. Tauri's [updater documentation](https://v2.tauri.app/plugin/updater/) describes the manifest and signing format.

For a local signed build, set `TAURI_SIGNING_PRIVATE_KEY` to the private-key file path and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string, then run:

```bash
npm run tauri -- build --config src-tauri/tauri.release.conf.json
```

The first Rust build with this feature still needs to be installed manually by users of the historical Electron release. End-to-end replacement and restart must be exercised using two signed packaged versions on each supported OS; unit tests and build checks do not establish that platform-specific installer behavior.
