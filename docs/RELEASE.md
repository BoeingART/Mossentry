# Mossentry v0.2.1

New installations now start with an empty inventory and no managed user data.

## Changes

- Removed the five automatically created CPU/GPU example servers. First launch and subsequent restarts keep the server inventory empty until you add or import servers.
- Upgrading also removes untouched, unused legacy example servers once. Modified servers and servers with users, credentials, audit activity, jobs or pending actions are retained.
- Managed user lists, profiles, user history and dashboard user counts start empty or at zero.
- The Add server form now leaves the SSH login account blank for you to supply.
- Startup smoke tests and regression tests verify the empty initial state and preservation of existing saved inventory and users.

## Downloads

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry_0.2.1_darwin-aarch64.dmg` |
| macOS 13+, Intel | `Mossentry_0.2.1_darwin-x86_64.dmg` |
| Windows 10/11 x64 | `Mossentry_0.2.1_windows-x86_64-setup.exe` |

Signed updater packages, signatures, `latest.json`, checksums and installation instructions are attached. v0.2.0 users can install through the in-app Update button. Upgrading preserves configured or used servers and synchronized user data while cleaning up unused default templates. Users of the historical Electron v0.1.0 release need to install the Rust edition manually once.

v0.2.1 移除了首次启动时自动创建的五台示例服务器。新安装默认为 0 台服务器，用户列表、用户资料与用户历史均为空，统计为 0；新增服务器时 SSH 用户名也默认留空。升级时会一次性清理完全未使用、未修改的旧默认服务器，并保留已配置或使用过的服务器和用户数据。v0.2.0 用户可通过应用内更新按钮安装。
