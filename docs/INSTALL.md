# Installation and connection setup

[English README](../README.md) · [简体中文 README](../README-cn.md)

Download a desktop installer from [GitHub Releases](https://github.com/BoeingART/Mossentry/releases/latest). Managed Linux hosts use their existing SSH, Python 3 and Bash; no Mossentry agent or server-side service is installed.

## macOS

Use the Apple Silicon or Intel DMG matching your Mac, then drag Mossentry to Applications. The application uses the system WebKit and contains the Rust executable, interface assets and embedded remote probes. No separate Python, Node.js or Ansible is needed. The built-in SSH transport is self-contained; advanced login settings use macOS’s system OpenSSH client.

### Apple verification warning / Apple 无法验证

The published v0.2.0 through v0.3.0 macOS builds use ad-hoc signing and have not been notarized by Apple. macOS can display “Apple could not verify Mossentry.app is free of malware” and block the first launch. The updater's `.sig` files authenticate updates to Mossentry; they do not supply an Apple Developer ID signature or notarization.

If you downloaded the app from this project's GitHub Releases and choose to trust it, use Apple's [Open Anyway procedure](https://support.apple.com/en-us/102445):

1. Drag Mossentry to Applications, open it once, and dismiss the warning with **Done**.
2. Open **System Settings → Privacy & Security**, scroll to Security, and click **Open Anyway** next to the Mossentry warning.
3. Authenticate if requested and confirm **Open**. macOS saves an exception for this app.

当前发布的 v0.2.0 至 v0.3.0 macOS 安装包尚未经过 Apple 公证，首次打开可能出现“Apple 无法验证 Mossentry.app”的提示。确认安装包来自本项目的 GitHub Releases 并决定信任后，可以按以下步骤打开：

1. 将 Mossentry 拖到“应用程序”，打开一次，弹出警告后点击“完成”。
2. 打开“系统设置 → 隐私与安全性”，向下找到“安全性”区域，在 Mossentry 被阻止的提示旁点击“仍要打开”。
3. 按系统要求验证身份，再确认“打开”。此后 macOS 会保留对此应用的例外设置。

Managed Macs may restrict this option; contact the administrator if it is unavailable. A release that passes Apple's normal verification requires Developer ID Application signing and Apple notarization. Maintainers can provision these through [UPDATES.md](UPDATES.md#macos-developer-id-signing-and-notarization).

## Windows

Use the x64 NSIS installer on Windows 10/11. Tauri uses Microsoft WebView2; the installer can bootstrap it if missing. The built-in SSH transport needs no WSL, Python, Ansible or OpenSSH installation. SSH config imports, jump hosts and agent authentication use the Windows OpenSSH Client optional feature. Private-key paths may use `C:\Users\yourname\.ssh\id_ed25519`; host keys are read from `%USERPROFILE%\.ssh\known_hosts`. Encrypted keys can be used through an already-unlocked SSH agent with the OpenSSH transport.

## In-app updates

The Rust edition checks the latest stable GitHub Release on launch, every ten minutes and when the network reconnects. The top-right **Update / 更新** button appears only when a higher version is available for your platform. Click it to download the signed package. The button shows download progress, then a second click installs and restarts Mossentry. Local configuration and data remain in their existing directory. Finish running server operations before applying an update; installation is blocked while an operation is active. Download and installation failures require a click on the same button to retry.

Automatic updates require a release containing `latest.json` and signed updater packages. The historical Electron v0.1.0 release cannot gain this feature remotely; install the first Rust release with update support manually. Development runs do not check or install updates. Release maintainers should follow [UPDATES.md](UPDATES.md).

## Existing data

The application reuses the existing Mossentry or legacy application data directory and `mossentry.db` / `server_manager.db` in place, including WAL sidecars, saved sudo passwords, pending requests, credential archives, profiles and operation history. Quit the Electron build before opening the Rust build. The Rust instance lock does not protect against the older Electron application.

Back up the whole data directory while the application is closed before migrating valuable installations. See [application data](#application-data) for paths and overrides.

## SSH setup

New installations start with zero servers, no managed user information and empty user statistics. Add servers or import hosts from your SSH config file (`~/.ssh/config`, or `%USERPROFILE%\.ssh\config` on Windows) and supply the SSH login account before connecting. Upgrades remove only untouched, unused legacy example servers once; configured or used servers and saved user data remain available. Verify each SSH fingerprint and add it to `~/.ssh/known_hosts`. The built-in transport rejects unknown or changed keys, uses only the configured private key and enforces owner-only key permissions on Unix. The OpenSSH transport defaults to strict host checking and honors saved host-checking options.

Managed hosts require Linux, `/usr/bin/python3`, Bash and appropriate sudo permission. Python scripts execute on the remote host over SSH and are not installed as agents. Launching the application does not change remote accounts.

Configure the login account and private-key path per server. Unix private keys must be owner-only (`0600`); the built-in transport requires an unencrypted key, while OpenSSH can use encrypted keys already loaded in an SSH agent. Account discovery and changes require suitable sudo privileges and standard Linux account tools, including `getent`, `useradd` and `usermod`. NVIDIA GPU metrics additionally require a compatible installed driver and `nvidia-smi`.

A saved sudo password is optional. Leaving its field blank during editing retains the saved value; changing the address, port or login account clears it unless a replacement is supplied. Saved sudo passwords are stored locally without encryption, excluded from responses and audit details, and sent over encrypted SSH stdin. The existing private `srvmgr.passwd` file or `MOSSENTRY_BECOME_PASSWORD_FILE` can supply a fallback; otherwise passwordless sudo is used.

Connection changes invalidate cached accounts. Pending approval operations must be handled before editing or removing their servers.

## SSH config import and login options

Use **Import SSH config** on the Servers page. The default file is `~/.ssh/config` on macOS/Linux and `%USERPROFILE%\.ssh\config` on Windows; Browse can select another file. Preview resolves explicit `Host` aliases, wildcard/negated defaults, multiple aliases per block and `Include` files in lexical order. Scalar options use OpenSSH's first-value precedence, while identity and certificate files accumulate. Select the hosts to add individually or use the checkbox beside the selection count. It shows **Deselect all** when all new hosts are selected and **Select all** otherwise. Existing names remain unchanged and cannot be selected; new entries have management enabled by default. The preview hides ports and SSH Host aliases, while retaining both in the imported connection settings. Preview and import read local files without opening network connections or executing proxy commands. If the source changes before confirmation, preview it again.

Imported names are normalized to Mossentry's lowercase server-name format. The original alias is saved separately for OpenSSH tokens. Login settings and referenced `ProxyJump` host definitions are copied into local server records, so changing the source config afterward does not change an imported connection. Review imported settings before connecting. Imports do not copy private key contents or sudo passwords. Inventory export is no longer available; exporting task results and downloading generated credentials still work.

The server editor includes connection fields and **More SSH login settings**. Supported settings include:

- `HostName`, `User`, `Port`, multiple `IdentityFile` and `CertificateFile` entries.
- `ProxyJump` with comma-separated hops, separate accounts, ports and identity files for each hop; `ProxyCommand` for a local proxy command. Choose one proxy mechanism per host. Imported jump aliases are saved under Jump host definitions. A manually added alias also needs its Host definition there; a direct `user@hostname:port` needs none.
- `IdentityAgent`, `IdentitiesOnly`, `AddKeysToAgent`, `UseKeychain` on macOS, authentication preferences and public-key authentication settings. Leaving the main key path blank allows SSH agent/default identities. Unlock encrypted keys in your agent before connecting.
- `UserKnownHostsFile`, `GlobalKnownHostsFile`, `HostKeyAlias`, `StrictHostKeyChecking`, `CheckHostIP`, `HashKnownHosts` and host-key/public-key algorithm preferences.
- `ConnectTimeout`, `ConnectionAttempts`, `ServerAliveInterval`, `ServerAliveCountMax`, `TCPKeepAlive`, `Compression`, `ForwardAgent`, `AddressFamily`, `BindAddress`, `BindInterface`, ciphers, key-exchange algorithms and MACs.

Additional entries use OpenSSH syntax in the login-options field. Quote paths containing spaces. The editor also exposes the imported jump-host definitions. Routing, authentication or trust-setting changes clear cached accounts/connection results and the saved sudo password; finish pending approval requests before editing.

`Match` blocks are rejected explicitly. Other unsupported directives appear as skipped options in the preview. Local/remote startup commands, forwarding rules, interactive sessions and shared SSH control sockets are not imported. OpenSSH runs in batch mode; password prompts and interactive MFA are unavailable. `ProxyCommand` executes its configured local command only when you connect; if that command launches a separate `ssh`, its own `-F`/default config rules apply. It is not automatically rewritten to use the saved jump definitions.

Existing servers keep the built-in SSH transport unless you choose OpenSSH. On Windows, enable **Settings → System → Optional features → OpenSSH Client** if that transport is unavailable. macOS includes `/usr/bin/ssh`. Removing a saved server now needs only confirmation, without retyping its name.

## Application data

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/Mossentry` |
| Windows | `%APPDATA%\Mossentry` |
| Linux | `~/.config/Mossentry` |

The database lives under `data/mossentry.db`. Existing installation names, `server_manager.db`, cached users, history, saved credentials and preferences remain compatible. `MOSSENTRY_USER_DATA_DIR`, `MOSSENTRY_DATA_DIR` and `MOSSENTRY_DB_PATH` override storage locations; previous `SRVMGR_*` aliases are accepted. Unix application directories/files use `0700`/`0600`.

A database lock prevents concurrent Rust instances. Interrupted operations are recorded for review and are not automatically retried. Native save dialogs export JSON and one-time credential ZIPs; cancellation or a failed write leaves credentials available.

## Build from source

See the [development guide](DEVELOPMENT.md) for prerequisites, source setup, verification and installer builds.
