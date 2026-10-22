# Mossentry v0.2.2

Import servers directly from SSH config and use jump hosts, SSH agents and additional login settings.

## Changes

- Replaced inventory JSON import with SSH config file import. Defaults to `~/.ssh/config` on macOS/Linux and `%USERPROFILE%\.ssh\config` on Windows, with a native file picker, host preview and selection. Existing servers remain unchanged and imported servers start paused. Inventory export was removed; task-result exports and credential downloads remain available.
- Removing a server now requires one confirmation, without retyping the server name. Remote users/files and local operation history are preserved.
- Added the system OpenSSH transport and editable login options for ProxyJump chains, ProxyCommand, SSH agent, multiple identities and certificates, known-host files and aliases, authentication/algorithm preferences, connection timeout, keepalive, compression and agent forwarding. Imported jump-host login settings are saved with the server. Existing servers retain the built-in transport.
- Added regression and real SSH tests covering import selection and changed files, configuration preservation, direct/agent/proxy/multiple-hop connections, host-key rejection, payload framing, output limits and timeouts.

## Downloads

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry_0.2.2_darwin-aarch64.dmg` |
| macOS 13+, Intel | `Mossentry_0.2.2_darwin-x86_64.dmg` |
| Windows 10/11 x64 | `Mossentry_0.2.2_windows-x86_64-setup.exe` |

macOS packages remain ad-hoc signed and **have not been notarized by Apple**. After trusting the download from this repository, open the app once, dismiss the warning, then use **System Settings → Privacy & Security → Open Anyway**. This release does not remove Apple's first-launch verification warning.

Signed updater packages, signatures, `latest.json`, checksums and installation instructions are attached. Existing Rust versions can update in-app. OpenSSH features require the system SSH client; on Windows, enable the OpenSSH Client optional feature if missing. Authentication is noninteractive through keys or SSH agent; interactive password/MFA prompts and `Match` config blocks are unsupported.

v0.2.2 支持从 SSH config 预览并选择导入主机，移除了服务器清单导出；删除服务器只需确认一次。服务器配置新增多级跳板机、ProxyCommand、SSH agent、多私钥/证书、主机指纹文件与别名、超时和保活等常见登录选项。macOS 安装包继续保留未公证状态，首次打开需在“隐私与安全性”中选择“仍要打开”。Windows 使用扩展连接功能时需要系统 OpenSSH 客户端。
