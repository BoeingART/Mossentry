# Rust migration

The `dev-rust` branch starts from `dev-forward`. Tauri 2 replaces Electron. Rust replaces the local FastAPI/Ansible/Paramiko service; there is no Python sidecar or local HTTP listener. React, Mantine, CodeMirror, charts, translations and CSS remain the UI implementation so their appearance and interaction can be retained.

## Feature coverage

| Existing behavior | Rust implementation / retained UI |
| --- | --- |
| Dashboard totals, historical dates and eligibility | `history.rs`, original DashboardPage and charts |
| Server add/edit/pause/remove, group, notes and sudo passwords | `service.rs`, compatible SQLite tables |
| Inventory preview/import/export | Atomic Rust validation/inserts, original form, native JSON save |
| SSH connection test and status | `ssh.rs`, embedded `remote_actions.py` |
| Sync accounts and preserve creation history | Rust parsing/storage, unchanged remote creation probe |
| Account protection, pending approvals, reject and execute | `actions.rs`, checks before queue and execution plus remote revalidation |
| Ed25519 credentials, initial password and one-time ZIP | Rust key generation, SHA-512 crypt, private archive and save dialog |
| CPU/GPU/memory/network/disks and user filters | Unchanged remote resource probe and charts, Rust sample cache and concurrency limits |
| Multiline Bash, syntax checks, risk acknowledgement, sudo and timeout | Rust job coordinator, unchanged remote execution probe |
| Diagnostic summaries, history, export, deletion and legacy results | `operations.rs`, original results interface |
| Language, light/dark appearance and window behavior | Existing preferences migrated before UI startup, native window controls |
| Legacy database and credentials | In-place additive schema updates; no automatic re-execution |

The four Python files under `src-tauri/remote` execute only on managed Linux hosts using their existing interpreter. They are embedded at compile time, require no local Python, and preserve the established CPU/GPU/disk sampling, account protections and Bash process handling. Python under `remote-tests` is development verification only.

## Storage and concurrency

The database schema remains compatible with existing installations. Data discovery checks the same legacy directory names and database filenames. Unix storage directories use 0700; the database, credential ZIPs and preference file use 0600. Sudo passwords retain the original plaintext-at-rest contract. The Rust edition acquires an exclusive data-file lock; do not open an older Electron build on the same data simultaneously.

Server edits, scans, account approvals and command jobs share an operation lock. Command jobs persist queued/running/per-host/final state and hold the lock until the worker finishes. Resource monitoring is independent, bounded to one sample per connection and cached for three seconds. Restart marks unfinished jobs and approved actions as interrupted/failed without rerunning remote changes.

The native save dialog returns a selected destination only to Rust. Cancelling leaves credentials available. Credential files must be saved outside the application data directory under a new filename. A successful write marks the archive consumed and removes the source. Historical ZIP archives are reusable through the same flow.

## Verification

`npm run check` builds TypeScript and runs frontend chart, Rust workflow and remote-probe tests. `npm run check:rust` checks the full desktop build with Clippy. `npm run test:ssh` runs the actual Rust SSH transport and account lifecycle against a loopback-only disposable Docker container. Rust tests inject a fake transport and use temporary databases; remote probe tests use mocks or local shell fixtures. None contact the configured example hosts.

On 2026-10-21, the Apple Silicon build passed 15 chart tests, 32 Rust workflow tests, 42 remote-probe tests and the live SSH integration test. The integration covers Ed25519/RSA/ECDSA and hashed known-host entries, rejected unknown keys, timeout handling, password and passwordless sudo, credential export, the account lifecycle, monitoring and command diagnostics. The native WebView successfully loaded the dashboard through Rust IPC. The macOS app and DMG build, packaged startup smoke test and ad-hoc signature verification passed. Screen-by-screen visual acceptance was unavailable because computer-control permission was not granted.

The release workflow builds the native app on macOS arm64/x64 and Windows x64, tests the Rust core on each platform, and exercises remote account changes inside a disposable Linux container. It uploads installers on manual runs and publishes only on an explicit version tag.

Live managed-server acceptance and Windows/Intel visual checks still need the respective environments. Automated mock tests establish behavior and contracts, not successful changes on a production server.
