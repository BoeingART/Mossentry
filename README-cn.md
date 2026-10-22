<div align="center">

<h1><img src="icon-full.svg" alt="Mossentry" width="440" /></h1>

<p><strong>一个app，管好你的服务器。</strong></p>
<p>集中管理用户权限，跨服务器批量执行任务，随时查看资源使用情况。</p>

<p>
  <a href="https://github.com/BoeingART/Mossentry/releases"><img src="https://img.shields.io/github/v/release/BoeingART/Mossentry?style=flat-square&amp;color=008f82" alt="最新版本" /></a>
  <a href="https://github.com/BoeingART/Mossentry/actions/workflows/release.yml"><img src="https://github.com/BoeingART/Mossentry/actions/workflows/release.yml/badge.svg" alt="桌面版构建检查" /></a>
  <img src="https://img.shields.io/badge/desktop-macOS%20%7C%20Windows-263d36?style=flat-square" alt="提供macOS和Windows安装包" />
  <img src="https://img.shields.io/badge/SSH-agentless-7faa69?style=flat-square" alt="通过本地SSH连接" />
</p>

<p><a href="README.md">English</a> · <strong>简体中文</strong></p>

<p>
  <a href="#why-mossentry">Why Mossentry?</a> ·
  <a href="#主要功能">主要功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#文档">文档</a>
</p>

</div>

## Why Mossentry?

**服务器端无需安装额外的service，使用已有的SSH和Python即可连接。**

Mossentry是一款在你自己电脑上运行的Linux服务器管理桌面应用。它通过SSH按需运行远端程序，执行任务并采集资源数据。服务器上无需部署Mossentry常驻进程或Web管理服务，也无需开放额外的管理端口。

### 部署更省事，减少对外开放的服务

| | Mossentry | Cockpit | Webmin |
| --- | --- | --- | --- |
| 使用界面 | 本地桌面应用 | Web管理界面 | Web管理界面 |
| 服务器端准备 | SSH、Python 3和Bash | 安装Cockpit并启用socket | 安装Webmin及其服务 |
| 管理入口 | 已有的SSH端口 | HTTPS | HTTPS |
| 需要维护的管理软件 | 本地桌面应用 | 服务器端Web管理服务 | 服务器端Web管理服务 |

Mossentry复用已有的SSH访问方式，连接前校验服务器主机密钥。服务器清单和操作历史保存在自己的电脑上，省去新增HTTP管理入口所需的服务部署、证书配置及访问规则维护。同时避免网站配置不当暴露服务器信息

### 服务器安装要求

**服务器上无需额外安装Python包或Mossentry服务。**SSH密钥要求和权限配置见[连接设置](docs/INSTALL.md#ssh-setup)。

| 要求 | 说明 |
| --- | --- |
| 操作系统 | Linux |
| 连接方式 | 可用的SSH连接、私钥及已核验的服务器指纹 |
| 运行环境 | `/usr/bin/python3`、Bash和常规Linux工具 |
| 账户管理 | 同步账户权限和修改账户需要相应的sudo权限 |
| NVIDIA GPU监控 | 需要已安装的NVIDIA驱动和`nvidia-smi`，仅查看GPU指标时需要 |

## 主要功能

### 🔐 用户与权限管理

集中查看各台服务器上的账户，了解谁能登录、谁拥有管理权限。

- 同步已有Linux账户，跨服务器查看登录状态和sudo权限。
- 在选定服务器上创建账户，启用或禁用登录，授予或撤销sudo权限，以及删除账户。
- 将多项账户变更加入待审批列表，统一核对后执行。
- 为新账户生成SSH凭据，导出登录资料包。

### ⚡ 跨服务器批量执行

一次编写任务，在多台服务器上执行，集中查看每台机器的结果。

- 编写Bash脚本并选择目标服务器，按需使用sudo和设置每台服务器的超时时间。
- 执行前检查Shell语法，核对指令风险。
- 查看各台服务器的输出、退出状态和诊断信息，随时查阅或导出任务历史。

### 📈 服务器资源监控

管理服务器时，直接查看资源用在哪里。

- 监控CPU、内存、网络、磁盘使用情况及受支持的NVIDIA GPU。
- 按用户筛选CPU和GPU活动，了解各个账户的资源占用。
- 查看近期变化趋势，排查资源争用，确认维护任务的执行效果。

## 快速开始

1. **[下载Mossentry](https://github.com/BoeingART/Mossentry/releases/latest)**，选择适合自己电脑的安装包。
2. 核验服务器的SSH指纹，并加入本地`known_hosts`文件。
3. 填写服务器地址、SSH登录账户和私钥路径，或导入已有的服务器清单。
4. 同步账户，核对权限，开始执行任务或查看资源使用情况。

| 桌面平台 | 安装包 |
| --- | --- |
| macOS 13+，Apple Silicon | Apple Silicon `.dmg` |
| macOS 13+，Intel | Intel `.dmg` |
| Windows 10/11，x64 | Windows `.exe`安装程序 |

使用安装包时，本地电脑无需另行安装其他软件。Linux桌面用户可[从源码构建](docs/DEVELOPMENT.md)，目前发布流程提供macOS和Windows安装包。

**macOS 首次打开提示“Apple 无法验证”**：v0.2.0、v0.2.1 尚未经过 Apple 公证。确认安装包来自本项目后，在“系统设置 → 隐私与安全性”中点击“仍要打开”，具体步骤见[安装指南](docs/INSTALL.md#apple-verification-warning--apple-无法验证)。

## 文档

| 指南 | 内容 |
| --- | --- |
| [安装与连接配置](docs/INSTALL.md) | 安装桌面应用、配置SSH和管理本地数据 |
| [操作指南](docs/OPERATIONS.md) | 账户审批、批量执行和资源监控 |
| [开发指南](docs/DEVELOPMENT.md) | 源码运行、检查、打包和目录结构 |
| [架构与迁移](docs/DEV-RUST.md) | Rust/Tauri实现及数据兼容说明 |

## 参与贡献

欢迎提交问题反馈、功能建议和Pull Request。可以[创建Issue](https://github.com/BoeingART/Mossentry/issues)描述问题或提议，也可以按照[开发指南](docs/DEVELOPMENT.md)开始修改代码。
