# Development guide

[English README](../README.md) · [简体中文 README](../README-cn.md)

Mossentry uses Tauri 2, a React/Mantine interface in the system WebView, and a Rust core for SQLite storage, SSH, approvals, credentials and operation history. Rust coordinates remote commands directly over SSH; Ansible is not part of the current implementation. See [architecture and migration](DEV-RUST.md) for implementation details.

## Prerequisites

Install Node.js 24+, Rust stable and the platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

| Platform | Additional build requirements |
| --- | --- |
| macOS | Xcode Command Line Tools |
| Windows | Microsoft C++ build tools, WebView2 and Perl for bundled OpenSSL |
| Linux | WebKitGTK 4.1 and the other distribution packages listed in the Tauri prerequisites |

On Windows, GitHub's runner uses Strawberry Perl. On macOS, the launcher uses installed Command Line Tools if the active Xcode compiler is unavailable. It never accepts Xcode license terms or changes the global developer-directory selection.

Python 3 is needed locally only for remote-probe tests. Docker is required only for the optional live SSH integration test.

## Run from source

```bash
npm ci
npm start
```

`npm start` builds and opens the native application with the Vite development server. `npm run dev:ui` runs only Vite; functional application use requires the native window and its Rust commands. There is no local HTTP backend or sign-in screen.

Node.js is a development/build dependency. The packaged app does not include Electron, Node.js, a local Python runtime or Ansible. The four embedded programs in `src-tauri/remote/` run on the managed Linux host using its existing `/usr/bin/python3` and Bash, without installing an agent or service.

Use an isolated application data directory when developing against disposable hosts. Storage paths and overrides are documented in [installation and connection setup](INSTALL.md#application-data).

## Verify

```bash
npm run check          # frontend build, tooling, chart/UI data, Rust and remote-probe tests
npm run check:rust     # full desktop Clippy checks
npm run fmt:rust       # format Rust sources
npm run test:ssh       # optional real SSH/account lifecycle test; requires Docker
```

Regular tests use temporary data and mocked SSH. The optional SSH test creates a disposable Linux container bound to loopback; it does not contact configured servers.

## Build installers

```bash
npm run dist:mac       # on macOS: app and DMG
npm run dist:win       # on Windows: NSIS installer
```

`npm run build` builds only the frontend into `dist/`. Native installers are generated under `src-tauri/target/release/bundle/`. Run `npm run dist` on Linux to build the native bundles configured for that platform.

The release workflow builds macOS arm64/x64 and Windows x64 packages. Manual runs upload artifacts; explicit version tags publish after tests, platform builds and package-version checks succeed. Both npm and Cargo lockfiles are committed.

For signed release packages, follow [release and updater setup](UPDATES.md). User-facing release notes are in [RELEASE.md](RELEASE.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `frontend/src/` | React interface, charts, translations and native IPC calls |
| `frontend/tests/` | Chart, filtering and approval-list regression tests |
| `src-tauri/src/` | Rust desktop entry point and application services |
| `src-tauri/remote/` | Embedded Linux programs sent over SSH |
| `src-tauri/tests/` | Rust workflow, migration and live SSH tests |
| `src-tauri/icons/` | Desktop icon resources generated from `icon.svg` |
| `icon.svg` | Square source icon for desktop packaging |
| `icon-full.svg` | Full vector logo and wordmark used by both READMEs |
| `remote-tests/` | Remote-probe tests using Python's standard library |
| `scripts/` | Rust launcher, cleanup utility and disposable integration fixtures |
| `docs/` | Installation, workflows, development and migration documentation |

Generate desktop icon resources with `npm run build:icons`. The full README logo is a separate asset and is not an application icon input.

## Keep the checkout clean

Generated dependencies, build output, installer packages and caches are ignored. The repository contains source, dependency lockfiles and required assets; old desktop runtimes and installer copies are not maintained in the checkout.

```bash
npm run clean -- --dry-run   # preview generated output/cache removal
npm run clean               # remove dist, Rust output, generated schemas and caches
npm run clean:all           # also remove node_modules; restore with npm ci
```

Cleanup preserves source, Git history, lockfiles and application data. Git history retains earlier desktop versions and assets.
