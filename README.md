<div align="center">

<h1><img src="icon-full.svg" alt="Mossentry" width="440" /></h1>

<p><strong>One app to manage your servers.</strong></p>
<p>Manage user access, run commands across servers, and see where resources go.</p>

<p>
  <a href="https://github.com/BoeingART/Mossentry/releases"><img src="https://img.shields.io/github/v/release/BoeingART/Mossentry?style=flat-square&amp;color=008f82" alt="Latest release" /></a>
  <a href="https://github.com/BoeingART/Mossentry/actions/workflows/release.yml"><img src="https://github.com/BoeingART/Mossentry/actions/workflows/release.yml/badge.svg" alt="Desktop release checks" /></a>
  <img src="https://img.shields.io/badge/desktop-macOS%20%7C%20Windows-263d36?style=flat-square" alt="Desktop installers for macOS and Windows" />
  <img src="https://img.shields.io/badge/SSH-agentless-7faa69?style=flat-square" alt="Connect over SSH from your computer" />
</p>

<p><strong>English</strong> · <a href="README-cn.md">简体中文</a></p>

<p>
  <a href="#why-mossentry">Why Mossentry?</a> ·
  <a href="#features">Features</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#documentation">Documentation</a>
</p>

</div>

## Why Mossentry?

**No additional server-side service to install. Connect using the SSH and Python already on your servers.**

Mossentry is a desktop app for managing Linux servers from your own computer. It sends tasks and collects metrics over SSH, using short-lived remote programs. There is no Mossentry daemon to maintain, no web console to deploy, and no extra management port to open.

### Less setup, fewer exposed services

| | Mossentry | Cockpit | Webmin |
| --- | --- | --- | --- |
| Interface | Native desktop app | Web console | Web console |
| Server setup | SSH, Python 3 and Bash | Cockpit packages and socket | Webmin package and service |
| Management endpoint | Your existing SSH port | HTTPS | HTTPS |
| Management software to maintain | Desktop app | Server-side web console | Server-side web console |

Mossentry reuses your SSH access and verifies server host keys before connecting. Your inventory and operation history stay on your computer. This avoids adding an HTTP administration endpoint and the associated web service setup, certificate configuration and access rules. It also avoids exposing server information through a misconfigured web console.

### What your servers need

**No additional Python packages or Mossentry services are required on the server.** See [connection setup](docs/INSTALL.md#ssh-setup) for SSH key requirements and permissions.

| Requirement | Details |
| --- | --- |
| Operating system | Linux |
| Connection | SSH access with a private key and a verified host fingerprint |
| Runtime | Python 3 at `/usr/bin/python3`, Bash and standard Linux utilities |
| Account administration | Sudo privileges for account discovery and changes |
| NVIDIA GPU monitoring | An installed NVIDIA driver and `nvidia-smi`, only if GPU metrics are needed |

## Features

### 🔐 User and permission management

Keep track of who can access each server and what they can do.

- Discover existing Linux accounts and review their sign-in status and sudo access across servers.
- Create accounts on selected hosts, enable or disable sign-in, grant or revoke sudo, and remove accounts.
- Collect account changes into a pending list and review them together before execution.
- Generate SSH credentials for new accounts and export their login bundle.

### ⚡ Batch operations across servers

Run a maintenance task across selected hosts from one place.

- Write a Bash script once and run it on multiple servers, with optional sudo and per-server timeouts.
- Check shell syntax and review command risks before running a task.
- Inspect each server's output, exit status and diagnostics, then revisit or export the saved task history.

### 📈 Resource monitoring

See how your servers are being used while you work.

- Track CPU, memory, network, disk usage and supported NVIDIA GPUs.
- Filter CPU and GPU activity by user to understand who is consuming resources.
- Follow recent usage trends to investigate contention and check the effect of maintenance tasks.

## Get started

1. **[Download Mossentry](https://github.com/BoeingART/Mossentry/releases/latest)** for your computer.
2. Verify your servers' SSH fingerprints and add them to your local `known_hosts` file.
3. Add a server with its address, SSH login account and private-key path, or import your inventory.
4. Sync accounts, review permissions, and start running tasks or monitoring resources.

| Desktop platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | Apple Silicon `.dmg` |
| macOS 13+, Intel | Intel `.dmg` |
| Windows 10/11, x64 | Windows `.exe` installer |

The packaged app needs no additional software installed on your computer. Linux desktop users can [build from source](docs/DEVELOPMENT.md); the release workflow currently provides macOS and Windows installers.

**macOS first-launch Apple verification warning:** v0.2.0 and v0.2.1 have not been notarized by Apple. If you trust the download from this project, use **System Settings → Privacy & Security → Open Anyway**. See the [installation guide](docs/INSTALL.md#apple-verification-warning--apple-无法验证) for the full procedure.

## Documentation

| Guide | What you will find |
| --- | --- |
| [Installation and connection setup](docs/INSTALL.md) | Desktop installation, SSH requirements and local data |
| [Operation workflows](docs/OPERATIONS.md) | Account approvals, batch commands and monitoring |
| [Development guide](docs/DEVELOPMENT.md) | Run from source, checks, packaging and repository layout |
| [Architecture and migration](docs/DEV-RUST.md) | Rust/Tauri implementation and data compatibility |

## Contributing

Bug reports, feature ideas and pull requests are welcome. [Open an issue](https://github.com/BoeingART/Mossentry/issues) to share a problem or proposal, or follow the [development guide](docs/DEVELOPMENT.md) to work on the app.
