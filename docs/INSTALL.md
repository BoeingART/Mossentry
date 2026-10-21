# Install the Rust edition

The `dev` branch now contains the Rust/Tauri application merged from `dev-rust`. Previously published Electron installers are historical builds and do not represent the current source.

## macOS

Use the Apple Silicon or Intel DMG matching your Mac, then drag Mossentry to Applications. The application uses the system WebKit and contains the Rust executable, interface assets and embedded remote probes. No separate Python, Node.js, Ansible or SSH client is needed. Unsigned development builds may need approval in System Settings → Privacy & Security.

## Windows

Use the x64 NSIS installer on Windows 10/11. Tauri uses Microsoft WebView2; the installer can bootstrap it if missing. No WSL, Python, Ansible or OpenSSH installation is required. Private-key paths may use `C:\Users\yourname\.ssh\id_ed25519`; host keys are read from `%USERPROFILE%\.ssh\known_hosts`. Passphrase-encrypted SSH keys are not supported.

## In-app updates

The Rust edition checks the latest stable GitHub Release on launch, every ten minutes and when the network reconnects. The top-right **Update / 更新** button appears only when a higher version is available for your platform, and the signed package downloads automatically. The button shows download progress, then installs and restarts Mossentry when clicked. Local configuration and data remain in their existing directory. Finish running server operations before applying an update; installation is blocked while an operation is active. Download and installation failures can be retried from the same button.

Automatic updates require a release containing `latest.json` and signed updater packages. The historical Electron v0.1.0 release cannot gain this feature remotely; install the first Rust release with update support manually. Development runs do not check or install updates. Release maintainers should follow [UPDATES.md](UPDATES.md).

## Existing data

The application reuses the existing Mossentry or legacy application data directory and `mossentry.db` / `server_manager.db` in place, including WAL sidecars, saved sudo passwords, pending requests, credential archives, profiles and operation history. Quit the Electron build before opening the Rust build. The Rust instance lock does not protect against the older Electron application.

The default directory is `~/Library/Application Support/Mossentry` on macOS, `%APPDATA%\Mossentry` on Windows and `~/.config/Mossentry` on Linux. Set `MOSSENTRY_USER_DATA_DIR` to select an isolated directory, or `MOSSENTRY_DATA_DIR` / `MOSSENTRY_DB_PATH` for specific storage overrides. Previous `SRVMGR_*` aliases are accepted. Back up the whole data directory while the application is closed before migrating valuable installations.

## SSH setup

New installations start with zero servers, no managed user information and empty user statistics. Add or import your own servers and supply the SSH login account before connecting. Upgrades remove only untouched, unused legacy example servers once; configured or used servers and saved user data remain available. Verify each SSH fingerprint and add it to `~/.ssh/known_hosts`. The Rust transport rejects unknown or changed keys, uses only the configured private key and enforces owner-only key permissions on Unix.

Managed hosts require Linux, `/usr/bin/python3`, Bash and appropriate sudo permission. Python scripts execute on the remote host over SSH and are not installed as agents. Launching the application does not change remote accounts.

## Build from source

Install Node.js 24+, Rust stable and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Run `npm ci`, then `npm start`. Build installers with `npm run dist:mac` or `npm run dist:win` on the target operating system. Output is under `src-tauri/target/release/bundle`.

On Windows the OpenSSL source build also needs Perl; GitHub's Windows runner includes Strawberry Perl. On macOS the launcher automatically uses installed Command Line Tools if the active Xcode compiler is unavailable. It never accepts Xcode license terms or changes the global developer-directory selection.
