# Mossentry v0.3.1

Import SSH hosts with fewer steps, view firewall status across servers, and choose when update downloads begin.

## Changes since v0.3.0

- SSH config imports load hosts automatically when the dialog opens or the file path changes. Hosts start unselected; the selection checkbox switches between **Select all** and **Deselect all**, skipping existing servers. Newly imported servers have management enabled by default, while existing servers remain unchanged.
- Simplified the SSH import list by hiding ports and SSH Host aliases while preserving both in the saved connection settings. If the source config changes before import, the list reloads and requires a fresh selection.
- Added a firewall overview showing enabled, disabled, unavailable, failed, checking, waiting and paused states for each server. Select a server to manage its firewall. Status checks run serially and prevent responses from old connection settings from replacing current results.
- Replaced the firewall rule list with an expandable table showing rule type, destination port or port range, and actions. Expand a row to inspect the original UFW rule; unknown formats remain available without inventing a summary.
- Update checks now show an available update without downloading it. Downloads and retries start only after a click; installation still requires a separate click after signature verification.
- Removed icons from Operations submenu items and aligned command preview and execution actions with the timeout controls.

## Downloads

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry_0.3.1_darwin-aarch64.dmg` |
| macOS 13+, Intel | `Mossentry_0.3.1_darwin-x86_64.dmg` |
| Windows 10/11 x64 | `Mossentry_0.3.1_windows-x86_64-setup.exe` |

macOS packages remain ad-hoc signed and **have not been notarized by Apple**. After trusting the download from this repository, open the app once, dismiss the warning, then use **System Settings → Privacy & Security → Open Anyway**. This release does not remove Apple's first-launch verification warning.

Signed updater packages, signatures, `latest.json`, checksums, and installation instructions are attached. Existing Rust versions can update in-app. UFW management requires UFW on the managed Linux host and suitable sudo access. Existing application data and SSH settings remain compatible.

v0.3.1 简化了 SSH config 导入流程，打开窗口后自动加载主机，默认不勾选，支持全选和全不选，新导入的服务器默认启用管理。防火墙页面新增服务器状态总览，规则以可展开表格展示类型、目标端口和原始内容。发现新版本后先显示更新按钮，点击才开始下载，校验完成后再次点击安装。运维子菜单和命令操作区的布局也做了调整。macOS 安装包仍未经过 Apple 公证，首次打开需按安装说明操作。
