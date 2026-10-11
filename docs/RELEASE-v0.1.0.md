Mossentry's first desktop release for managing Linux servers over SSH.

- Server connections, account synchronization, access requests and approvals.
- CPU, GPU, memory, network and disk monitoring.
- English / 简体中文, light and dark appearance.
- Bundled native Python, SSH client and local interface; no separate runtime setup.

## Downloads / 下载

| Platform | File |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry-0.1.0-macOS-arm64.dmg` |
| macOS 13+, Intel | `Mossentry-0.1.0-macOS-x64.dmg` |
| Windows 10/11 x64 | `Mossentry-0.1.0-Windows-x64-Setup.exe` |

macOS ZIP archives and SHA-256 checksums are also attached.

**Windows runs natively: no WSL, Python or Ansible installation required.**
Both desktop clients use the bundled SSH transport and preserve strict host-key
verification. Configure your private key and known hosts on the client computer.

**Windows 版安装后即可运行，无需 WSL 或另装 Python。** 完整安装步骤见附件 `INSTALL.md`。

Remote account management and resource monitoring retain the existing Linux server
requirements. macOS hosts support SSH connection tests when `/usr/bin/python3` is
available; macOS account management and monitoring are not implemented in v0.1.0.

This release is unsigned and the macOS build is not notarized. macOS and Windows
may show an unverified-publisher warning. Native runtime and packaged backend
startup, authentication, UI loading and shutdown are smoke-tested on each platform.

No private keys, databases, passwords or local runtime data are included.
