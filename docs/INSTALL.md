# Install the Rust edition

This document describes the `dev-rust` branch. Previously published v0.1.0 Electron installers remain historical builds until a Rust release is published.

## macOS

Use the Apple Silicon or Intel DMG matching your Mac, then drag Mossentry to Applications. The application uses the system WebKit and contains the Rust executable, interface assets and embedded remote probes. No separate Python, Node.js, Ansible or SSH client is needed. Unsigned development builds may need approval in System Settings → Privacy & Security.

## Windows

Use the x64 NSIS installer on Windows 10/11. Tauri uses Microsoft WebView2; the installer can bootstrap it if missing. No WSL, Python, Ansible or OpenSSH installation is required. Private-key paths may use `C:\Users\yourname\.ssh\id_ed25519`; host keys are read from `%USERPROFILE%\.ssh\known_hosts`. Passphrase-encrypted SSH keys are not supported.

## Existing data

The application reuses the existing Mossentry or legacy application data directory and `mossentry.db` / `server_manager.db` in place, including WAL sidecars, saved sudo passwords, pending requests, credential archives, profiles and operation history. Quit the Electron build before opening the Rust build. The Rust instance lock does not protect against the older Electron application.

The default directory is `~/Library/Application Support/Mossentry` on macOS, `%APPDATA%\Mossentry` on Windows and `~/.config/Mossentry` on Linux. Set `MOSSENTRY_USER_DATA_DIR` to select an isolated directory, or `MOSSENTRY_DATA_DIR` / `MOSSENTRY_DB_PATH` for specific storage overrides. Previous `SRVMGR_*` aliases are accepted. Back up the whole data directory while the application is closed before migrating valuable installations.

## SSH setup

Edit or remove the initial example hosts before connecting. Verify each SSH fingerprint and add it to `~/.ssh/known_hosts`. The Rust transport rejects unknown or changed keys, uses only the configured private key and enforces owner-only key permissions on Unix.

Managed hosts require Linux, `/usr/bin/python3`, Bash and appropriate sudo permission. Python scripts execute on the remote host over SSH and are not installed as agents. Launching the application does not change remote accounts.

## Build from source

Install Node.js 24+, Rust stable and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Run `npm ci`, then `npm start`. Build installers with `npm run dist:mac` or `npm run dist:win` on the target operating system. Output is under `src-tauri/target/release/bundle`.

On Windows the OpenSSL source build also needs Perl; GitHub's Windows runner includes Strawberry Perl. On macOS the launcher automatically uses installed Command Line Tools if the active Xcode compiler is unavailable. It never accepts Xcode license terms or changes the global developer-directory selection.
