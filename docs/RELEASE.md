# Mossentry v0.3.2

Use readable server names and keep the save action visible while editing connection settings.

## Changes since v0.3.1

- Server names now accept up to 80 Unicode characters, including mixed case, Chinese, spaces, punctuation and emoji. Empty names, line breaks, control characters and reserved names remain invalid, with matching validation and localized guidance in the editor.
- Moved **Save server** into the sticky header of the add/edit dialog, so it stays visible while scrolling through SSH settings. Saving preserves the existing server identity, SSH configuration, saved sudo credentials and synced account associations.
- Added the Apache License 2.0 for the project's source code, documentation and original assets, with license information in both READMEs and package metadata.
- Added matching English and Chinese dashboard screenshots near the top of each README.
- Updated contributor guidance and pull-request checks to run tests without building desktop installers. Release tags continue to build and publish all supported platforms.

Existing application data and SSH settings remain compatible; no database migration is required.

## Downloads

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Mossentry_0.3.2_darwin-aarch64.dmg` |
| macOS 13+, Intel | `Mossentry_0.3.2_darwin-x86_64.dmg` |
| Windows 10/11 x64 | `Mossentry_0.3.2_windows-x86_64-setup.exe` |

macOS packages remain ad-hoc signed and **have not been notarized by Apple**. After trusting the download from this repository, open the app once, dismiss the warning, then use **System Settings → Privacy & Security → Open Anyway**. See the attached installation instructions for the full procedure.

Signed updater packages, signatures, `latest.json`, checksums, and installation instructions are attached. Existing Rust versions can update in-app.

v0.3.2 支持最长 80 个 Unicode 字符的服务器名称，可使用中文、大小写字母、空格、符号和 emoji。新增或编辑服务器时，“保存”按钮固定在窗口顶部，滚动查看 SSH 设置时也能直接保存。已有服务器身份、SSH 设置、sudo 凭据和账户关联保持兼容，无需数据库迁移。本版还补充了 Apache 2.0 许可证及授权说明，并在中英文 README 中加入对应语言的概览截图。PR 检查仅运行检查和测试，版本发布仍会生成全部受支持平台的安装包。macOS 安装包仍未经过 Apple 公证，首次打开请按安装说明操作。
