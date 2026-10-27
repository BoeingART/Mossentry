# Mossentry v0.3.3

Choose a password when creating a user, or leave it blank to keep the existing automatic password generator.

## Changes since v0.3.2

- Added an optional password field to **New user**, with masked input and a visibility toggle. A supplied password is used exactly as entered on every selected host. Leaving the field blank preserves the existing 16-character alphanumeric generator, including an uppercase letter and a digit.
- The one-time login credential archive contains the password actually set for the account, whether supplied manually or generated automatically. SSH key generation and the approval workflow remain the same.
- Pending manual passwords survive application restarts in the private local database, separately from approval payloads and audit history. Pending password records are removed when a request completes, fails or is rejected, including interrupted work recovered at startup.
- Added validation for control characters and Linux's password size limit, plus regression coverage for generated and manual passwords, multi-host execution, restart recovery and cleanup.

Existing application data and SSH settings remain compatible. The application automatically adds the table used for pending passwords; no manual migration is required.

## Downloads

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry_0.3.3_darwin-aarch64.dmg` |
| macOS 13+, Intel | `Mossentry_0.3.3_darwin-x86_64.dmg` |
| Windows 10/11 x64 | `Mossentry_0.3.3_windows-x86_64-setup.exe` |

macOS release signing follows the repository's configured release workflow. If macOS displays an Apple verification warning, follow the attached installation instructions.

Signed updater packages, signatures, `latest.json`, checksums, and installation instructions are included with a successful release. Existing Rust versions can update in-app.

v0.3.3 在“新建用户”窗口中增加可选密码输入框。填写后会在所有选定服务器上使用该密码；留空则继续使用原有的 16 位随机字母数字密码算法。一次性下载的登录凭据包含实际设置的密码。待审批密码可在应用重启后保留，不会出现在审批详情或审计记录中；请求完成、失败、拒绝，或启动时恢复中断任务后，会清除对应的待审批密码记录。现有应用数据和 SSH 配置保持兼容，新增数据表由应用自动创建，无需手动迁移。
