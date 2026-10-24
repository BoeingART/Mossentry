# Mossentry v0.3.0

Manage UFW firewall rules, synchronize enabled servers together, and use a clearer operations sidebar with system-aware appearance controls.

## Changes since v0.2.2

- Added UFW firewall management over SSH, including status, inbound allow rules, rule deletion, and enable/disable actions. Enabling UFW checks that an explicit rule allows the current SSH port and management address. Enable/disable actions and rule deletion require confirmation; changes are recorded in operation history.
- Added **Sync all servers** beside **Add server**. It synchronizes all enabled servers regardless of the current search or group filter, prevents duplicate submissions, and reports per-server failures.
- Grouped **Firewall** and **Execute commands** under an expandable **Operations** section in the sidebar, with a server selector on the firewall page. The section and selected child have distinct highlights.
- Removed Firewall and Ping shortcuts from server cards, the bottom-left monitor shortcut, and the top-right approval bell. Monitoring remains available from server cards, and approvals remain in the sidebar.
- New appearance preferences follow the computer's light/dark setting by default while preserving previously saved choices. The icon-only appearance button cycles through automatic, day, and night modes. Theme colors transition smoothly and respect reduced-motion preferences.
- Placed Windows minimize, maximize/restore, and close buttons in a dedicated top row, giving the theme and language controls the toolbar's full width. Window dragging and double-click maximize/restore are preserved; macOS header height is unchanged.

## Downloads

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry_0.3.0_darwin-aarch64.dmg` |
| macOS 13+, Intel | `Mossentry_0.3.0_darwin-x86_64.dmg` |
| Windows 10/11 x64 | `Mossentry_0.3.0_windows-x86_64-setup.exe` |

macOS packages remain ad-hoc signed and **have not been notarized by Apple**. After trusting the download from this repository, open the app once, dismiss the warning, then use **System Settings → Privacy & Security → Open Anyway**. This release does not remove Apple's first-launch verification warning.

Signed updater packages, signatures, `latest.json`, checksums, and installation instructions are attached. Existing Rust versions can update in-app. UFW management requires UFW on the managed Linux host and suitable sudo access. Existing SSH, jump-host, and SSH-agent features remain available; OpenSSH features require the system SSH client.

v0.3.0 新增 UFW 防火墙管理和全部已启用服务器的批量同步，将防火墙与命令执行统一放入可展开的运维菜单。外观默认跟随系统，也可切换日间和夜间模式。Windows 窗口按钮使用独立顶部行，不再挤占主题与语言控件。macOS 安装包仍未经过 Apple 公证，首次打开需按安装说明操作。
