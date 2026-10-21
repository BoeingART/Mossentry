# Mossentry v0.2.0

Mossentry now runs on Tauri 2 and Rust, with no local Python, Node.js, Ansible or SSH-client installation required.

## Changes

- Conditional Update button in the top-right corner: newer stable GitHub Releases download automatically, show progress, and install with a restart when clicked. Updates verify package signatures and versions, preserve local data, and wait for running server operations to finish.
- Shared approval lists, direct user-action submission and per-operation results with one-time credential downloads.
- SSH server management, account synchronization, inventory transfer and saved command history with diagnostic summaries.
- CPU, GPU, memory, network and physical-disk monitoring; improved dashboard history and access statistics.
- English and Simplified Chinese, persistent light/dark appearance and native window controls.

## Downloads

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry_0.2.0_darwin-aarch64.dmg` |
| macOS 13+, Intel | `Mossentry_0.2.0_darwin-x86_64.dmg` |
| Windows 10/11 x64 | `Mossentry_0.2.0_windows-x86_64-setup.exe` |

Signed updater archives/installers, their `.sig` files, `latest.json`, checksums and installation instructions are attached.

Users of the historical Electron v0.1.0 release must install v0.2.0 manually once. Quit the old app before launching the Rust edition. Existing data is reused; back it up before migration. Future releases support in-app updates. Updater signatures verify downloaded packages; macOS app notarization and Windows publisher signing are not configured, so the operating system may require approval on first installation.

v0.2.0 已迁移至 Rust/Tauri，新增后台下载更新、统一审批清单、命令诊断与资源监控改进。旧 Electron v0.1.0 用户需手动安装一次；后续版本可在应用内更新。迁移前请退出旧程序并备份本地数据。安装步骤见附件 `INSTALL.md`。
