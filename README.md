# Mossentry

<img src="icon.svg" width="112" height="112" alt="Mossentry icon" />

Mossentry is a Rust desktop application for managing Linux servers over SSH. The `dev` branch uses Tauri 2, a React/Mantine interface in the system WebView, and a Rust core for SQLite storage, SSH, approvals, credentials and operation history.

## Features

- **Dashboard**: cumulative user numbers, a last-year default view, the current sudo-user ratio and server account totals.
- **Servers**: connection settings, account synchronization, status, groups, notes, and JSON inventory import/export. Imported servers start paused.
- **Users & access**: filter actual host accounts by status and server, create users, enable/disable sign-in, grant/revoke sudo, edit local profiles and queue account deletion.
- **Approvals**: operations accumulate in one pending list. Review or remove individual items, then approve or reject the whole list. Every target is checked before execution; results and one-time credentials remain available per operation. Account deletion retains the home directory and files.
- **Operations**: multiline Bash editing, optional syntax checks, risk review, sudo, per-server timeouts, output diagnostics and saved task history with JSON export.
- **Monitoring**: CPU, NVIDIA GPU, memory, network and disk usage. Charts scroll over five minutes with fixed minute ticks and name-only legends. Disks sort by capacity and display media type and software RAID level when the host exposes them.
- **Appearance**: English/Simplified Chinese and persistent light/dark preferences, using system fonts.
- **Updates**: checks GitHub Releases at startup and every ten minutes. A newer version reveals the top-right Update button and downloads a signed package in the background; click when ready to install and restart. See [release setup](docs/UPDATES.md).

## Run from source

Install Node.js 24+, Rust stable and the platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). macOS needs Command Line Tools; Windows needs Microsoft C++ build tools, WebView2 and Perl for bundled OpenSSL. Linux needs WebKitGTK 4.1 and the other packages listed in the Tauri prerequisites.

```bash
npm ci
npm start
```

`npm start` builds and opens the native application with the Vite development server. `npm run dev:ui` runs only Vite; functional application use requires the native window and its Rust commands. There is no local HTTP backend or sign-in screen.

Node.js is a development/build dependency. The packaged app does not include Electron, Node.js, a local Python runtime or Ansible. The four embedded programs in `src-tauri/remote` run on the managed Linux host using its existing `/usr/bin/python3` and Bash.

## Verify

```bash
npm run check          # frontend build, tooling, chart/UI data, Rust and remote-probe tests
npm run check:rust     # full desktop Clippy checks
npm run fmt:rust       # format Rust sources
npm run test:ssh       # optional real SSH/account lifecycle test; requires Docker
```

Python 3 is needed locally for the remote-probe tests only. Regular tests use temporary data and mocked SSH. The optional SSH test creates a disposable Linux container bound to loopback; it does not contact configured servers.

## Build installers

```bash
npm run dist:mac       # on macOS: app and DMG
npm run dist:win       # on Windows: NSIS installer
```

`npm run build` builds only the frontend into `dist/`. Native installers are generated under `src-tauri/target/release/bundle/`.

The release workflow builds macOS arm64/x64 and Windows x64 packages. Manual runs upload artifacts; explicit version tags publish after tests, platform builds and package-version checks succeed. Both npm and Cargo lockfiles are committed.

See [installation and data migration](docs/INSTALL.md).

## SSH and application data

Managed hosts require Linux, `/usr/bin/python3`, Bash, key-based SSH and suitable sudo privileges for account changes. Configure the login account and key path per server. Unix private keys must be owner-only (`0600`); passphrase-encrypted keys are not supported. Verify each host fingerprint and add it to the local `~/.ssh/known_hosts` before connecting. Unknown and changed host keys are rejected.

New installations start with zero servers, no managed user accounts or profiles, and empty user statistics. Add servers manually or import an inventory, then sync their accounts. Upgrades remove untouched, unused legacy example servers once, preserving configured or used servers and user data. Connection changes invalidate cached accounts. Pending approval operations must be handled before editing or removing their servers.

A saved sudo password is optional. Leaving its field blank during editing retains the saved value; changing the address, port or login account clears it unless a replacement is supplied. Saved sudo passwords are stored locally without encryption, excluded from responses and audit details, and sent over encrypted SSH stdin. Unix application directories/files use `0700`/`0600`. The existing private `srvmgr.passwd` file or `MOSSENTRY_BECOME_PASSWORD_FILE` can supply a fallback; otherwise passwordless sudo is used.

Default application data directories:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/Mossentry` |
| Windows | `%APPDATA%\Mossentry` |
| Linux | `~/.config/Mossentry` |

The database lives under `data/mossentry.db`. Existing installation names, `server_manager.db`, cached users, history, saved credentials and preferences remain compatible. `MOSSENTRY_USER_DATA_DIR`, `MOSSENTRY_DATA_DIR` and `MOSSENTRY_DB_PATH` override storage locations; previous `SRVMGR_*` aliases are accepted.

A database lock prevents concurrent Rust instances. Interrupted operations are recorded for review and are not automatically retried. Native save dialogs export JSON and one-time credential ZIPs; cancellation or a failed write leaves credentials available.

## Repository layout

| Path | Contents |
| --- | --- |
| `frontend/src/` | React interface, charts, translations and native IPC calls |
| `frontend/tests/` | Chart, filtering and approval-list regression tests |
| `src-tauri/src/` | Rust desktop entry point and application services |
| `src-tauri/remote/` | Embedded Linux programs sent over SSH |
| `src-tauri/tests/` | Rust workflow, migration and live SSH tests |
| `src-tauri/icons/` | Desktop icon resources generated from `icon.svg` |
| `remote-tests/` | Remote-probe tests using Python's standard library |
| `scripts/` | Rust launcher, cleanup utility and disposable integration fixtures |
| `docs/` | Installation, operation workflows and migration notes |

## Keep the checkout clean

Generated dependencies, build output, installer packages and caches are ignored. The repository contains source, dependency lockfiles and required assets; old desktop runtimes and installer copies are not maintained in the checkout.

```bash
npm run clean -- --dry-run   # preview generated output/cache removal
npm run clean               # remove dist, Rust output, generated schemas and caches
npm run clean:all           # also remove node_modules; restore with npm ci
```

Cleanup preserves source, Git history, lockfiles and application data. Old Electron release notes and duplicated icon assets have been removed. Git history retains earlier versions.

See [operation workflows](docs/OPERATIONS.md) and [Rust migration details](docs/DEV-RUST.md).
