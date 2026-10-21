# Mossentry

<img src="icon.svg" width="112" height="112" alt="Mossentry icon" />

Rust desktop application for managing Linux servers over SSH, built with Tauri 2. The existing React, Mantine and TypeScript interface runs in the operating system WebView. SQLite persistence, SSH transport, account approvals, credentials, monitoring coordination and operation history run in Rust in the desktop process. Electron, the local HTTP server, Python runtime and Ansible are no longer shipped.

## Run

Install Node.js 24+, Rust stable and the platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On macOS, Command Line Tools are sufficient. Windows builds need the Microsoft C++ build tools, WebView2 and Perl for the bundled OpenSSL build. Linux builds need WebKitGTK 4.1 and the other packages listed in the prerequisites.

```bash
npm ci
npm start
```

`npm start` opens the native application and Vite development server. There is no sign-in screen. `npm run build` only builds the interface; `npm run dist` builds the native application and installer. The launch helper locates Rust under `~/.cargo/bin` and uses working macOS Command Line Tools when the active Xcode compiler is unavailable, without changing system settings.

```bash
npm run check
npm run check:rust
npm run dist:mac   # on macOS
npm run dist:win   # on Windows
```

`check` runs the frontend build, chart tests, Rust workflow tests and remote Linux probe tests. Python 3 is only needed locally to run those probe tests, not to run or package the desktop application. Tests use temporary databases and simulated SSH connections. See [Rust migration and verification](docs/DEV-RUST.md) and [installation](docs/INSTALL.md).

Scrollable pages, lists, dialogs, and dropdowns use top/bottom edge shadows instead of scrollbars. Mouse-wheel, touchpad, touch and keyboard scrolling remain available.

## Development

`frontend/src` retains the interface and calls Rust through Tauri IPC. The string routes in `api.ts` preserve the existing typed interface contract; they are not HTTP endpoints. `npm run dev:ui` alone is useful for frontend compilation, but functional use requires `npm start` inside the native WebView.

`src-tauri/src` implements the application in Rust. `src-tauri/remote` contains fixed, embedded Python programs sent over SSH to the target Linux host. They use that host's existing `/usr/bin/python3` and Bash; no local Python service or remote resident agent is required.

## Appearance and language

The upper-right controls switch between day and night mode and between English and Simplified Chinese. Both choices are saved locally and restored on the next launch. Switching language preserves the current page, form inputs, and monitoring history. Server names, usernames, addresses, and saved data remain as entered.

## Typography

Headings, body copy, controls, tables, chart text, and the wordmark share a native sans-serif stack for a restrained, ChatGPT-like appearance. English uses the platform UI font, such as San Francisco on macOS or Segoe UI on Windows. Chinese uses the system's matching glyph fallback, with explicit fallbacks for PingFang SC, Hiragino Sans GB, Microsoft YaHei, and Noto Sans SC/CJK SC. Fonts come from the operating system, so no font files or external font requests are needed; the exact face varies by platform. The stack is defined once as `--font-sans` in `frontend/src/styles.css` and is shared with the Mantine theme.

Typography sizes are shared between the Mantine theme and CSS through semantic variables in `frontend/src/styles.css`. Page titles use 28px, dialogs 22px, panel/chart titles 20px, and compact card titles 18px, with heading weight 600. Body text and navigation use 15px; controls and tables use 14px; chart axes and secondary data use 13px; compact badges and status text use 12px. Summary cards use 14px labels, 28px values at weight 600, and 13px trends; the central gauge total uses 32px at weight 600. Body line height is 1.55 and heading line height is 1.35. Responsive layouts retain this scale and wrap controls or stack panels as needed.

## Branding and icons

`icon.svg` is the source artwork for the interface logo and browser favicon. Vite includes it in the built assets embedded in the native application. `src-tauri/icons/icon.png` supplies the desktop window and macOS Dock icon; `icon.ico` and `icon.icns` provide Windows and macOS application icon resources. Regenerate all desktop formats after editing the SVG with `npm run build:icons`, then restart the app. The name shown in the window, application menu, About panel, and backend is **Mossentry**.

## Host connections and data

Add, edit, pause, or remove servers from the **Servers** page. The five hosts in `src-tauri/src/db.rs` seed new installations once; subsequent changes live in SQLite, and removed hosts stay removed after restart. The connection form accepts a hostname or IPv4/IPv6 address, SSH port, login account and an absolute or `~/` private-key path. The default management key is `~/.ssh/id_rsa`; existing servers keep their saved key paths. Set `MOSSENTRY_SSH_DIR` to use another key directory for the initial server inventory. Keys must have mode `0600`. Each remote host must accept SSH and grant the `srvmgr` account the configured sudo access.

If sudo needs a password, enter the SSH login account's password in **Sudo password (optional)** when adding or editing a server. The field starts empty and never displays the saved password. Leave it blank when editing to keep the existing password, enter a new value to replace it, or select **Clear saved sudo password** to remove it. Changing the hostname, SSH port, or login account clears the old password unless a replacement is supplied. Each server uses its own password for sync and account management; SSH tests and resource monitoring do not need it.

Passwords are stored locally in a separate SQLite credentials table, protected by owner-only permissions on the data directory (`0700`) and database (`0600`); they are not encrypted at rest. Passwords are excluded from API responses and audit details. Rust passes host-specific passwords over the encrypted SSH stdin stream; credentials are not put in process arguments or temporary inventories. For servers without a saved password, the existing `srvmgr.passwd` file (one nonempty line, mode `0600`), or `MOSSENTRY_BECOME_PASSWORD_FILE`, remains the fallback. If no password is configured, passwordless sudo is used.

Runtime data lives under `data` in the compatible Mossentry user-data directory. Set `MOSSENTRY_USER_DATA_DIR` to choose another parent directory. New installations use the `Mossentry` user-data directory and `mossentry.db`. Existing databases and their containing directories from earlier builds are reused in place, including SQLite sidecars and saved credentials. The `MOSSENTRY_*` environment variables take precedence; their previous `SRVMGR_*` equivalents remain supported. Remote SSH usernames such as `srvmgr` and the existing `srvmgr.passwd` file keep their operational meaning.

The Rust SSH client connects directly over TCP and does not create connection-reuse sockets or local child processes. Known-host verification remains required.

## Layout

- `src-tauri/src`: Rust desktop entry point, SQLite storage, SSH and application workflows.
- `src-tauri/remote`: embedded programs executed only on remote Linux hosts.
- `frontend/src`: preserved React and Mantine interface.
- `src-tauri/tests`: Rust workflow and migration regression tests.
- `remote-tests` and `frontend/tests`: remote probe and chart regression tests.

Only the local main WebView can invoke application commands. There is no listening HTTP service. A file lock prevents multiple Rust instances from opening the same database. Do not run the old Electron build and the Rust build against the same data directory at the same time. Interrupted jobs are marked for review at startup and are never retried automatically.

## Management workflows

The app opens on **Dashboard**. **User number** plots cumulative unique usernames
from their recorded creation dates, with all-time and shorter time ranges.
Dashboard user totals, account totals, recent growth, server account counts and
access overview exclude accounts whose UID is below 1000 and whose interactive
login is disabled (a shell ending in `/nologin` or `/false`). Low-UID accounts
with login enabled and all accounts with UID 1000 or above still count.
The same username on multiple hosts counts once if any account qualifies. Log dates take
precedence over home-directory birth-time estimates. Accounts without a usable
full date count in the total but are reported separately from the timeline.
The local username history and its last known eligibility survive account deletion
and server removal. Startup backfills eligibility from cached accounts; legacy
history without a remaining account retains its previous inclusion because its
UID and login state are unknown. The full account list remains available in Users & access.
Access overview summarizes permissions from the current cached account lists.
Old account caches are backfilled into history on startup; sync servers to
collect missing creation dates and any system accounts older scans omitted.

- **Servers**: test a single SSH connection, sync its accounts, or read uptime, load, memory and root-disk usage. **Sync all** refreshes enabled servers. Pausing a server excludes it from remote operations.
- **Users & access**: filter by server, create accounts, enable/disable interactive login, grant/revoke sudo membership, edit local display names, and request account deletion. Deletion requires typing the username and approval, keeps the home directory and files, and does not force-terminate sessions. System accounts and SSH management accounts are protected locally and checked again on the remote host, except for the usernames `srvmgr` and `sync`, which remain manageable regardless of UID or SSH login configuration.
- Pending requests must be handled before a server can be edited or removed. Removing a server removes only its local configuration and cached account list; remote accounts and files and local operation history are retained. Connection changes invalidate cached accounts. Remote operations are serialized with configuration changes.
- The interface shows short error explanations. Raw management execution details remain in the local database for troubleshooting. Failed syncs identify saved account data as potentially stale. **Status** remains a point-in-time snapshot; **Monitor** opens a dedicated resource monitoring page.

## Small-server operations

The **Operations** page accepts multiline Linux commands with Bash syntax
highlighting. Select hosts individually or use **Select all servers** to include
every enabled host. **Check syntax and risks** is optional and uses `bash -n` on
each target without executing the entered commands; **Run command** can be used
directly.
Deletion, permission changes and other potentially disruptive commands produce
warnings that must be acknowledged before execution. Dry run checks shell grammar;
it cannot validate command options, installed programs or whether an operation is
safe. Risk warnings are also shown when running directly.

Execution uses the SSH account, or the saved sudo configuration when selected.
Per-host results start collapsed, with green checkmarks for clean completion,
yellow indicators for **Completed with warnings**, and red crosses for failures.
Explicit diagnostic messages in stdout or stderr produce review hints, even when
the exit code is zero; nonempty stderr alone is not a warning or failure.
Expand a server to view diagnostic summaries, matching log lines and their source,
and the available stdout/stderr or an explicit no-output result. Log detection is
heuristic, not verification that the intended change succeeded. Original exit codes
and captured output remain unchanged. History and JSON exports include the
diagnostics; saved command history is reanalyzed locally on upgrade without
rerunning commands.
The Rust SSH transport requires Linux, Python 3 and Bash
on each target; the application adds no remote agents. **Servers** retains groups,
notes and inventory import/export; imported hosts start paused.
See [dev-forward workflows and limits](docs/DEV-FORWARD.md) for details.

## Monitor pages

Open **Monitor** in the left navigation to see the server list. Each **Open monitor** button opens that server's main monitoring page; **Monitor** on a Servers card goes directly to the same detail page. **All monitors** returns to the list. Both desktop and narrow windows use the main content area.

CPU, GPU and Memory have two-dimensional line charts with a fixed **0–100%** vertical axis and a rolling **5-minute** horizontal time axis. Each GPU has its own line. Samples start every **5 seconds**, rather than five seconds after the previous response. A slow request skips overlapping ticks. Collection stops while paused, hidden, or on another page. Ordinary failures retry on the same five-second cadence; authentication failures require reopening the desktop app before resuming. Charts connect valid points across missing samples and long sampling gaps without inserting zero values; older samples move out of the window. The page omits refresh/window captions and explanatory copy. History accumulates while a server detail page is open; opening another server starts a separate history. Charts use local sample receipt time to avoid differences between server and desktop clocks.

- **CPU** shows a one-second `/proc` counter difference, a recent-sample trend, and optional filtering by effective process owner. The separate CPU-by-user table is omitted. Percentages use the whole host's logical CPU capacity (100% means all CPUs). Processes that disappear during the sample, or whose ownership changes, may be omitted.
- **GPU** supports NVIDIA hosts with `nvidia-smi`. Each device reports utilization, temperature and framebuffer usage. Per-process SM utilization and framebuffer memory come from `pmon`, including graphics processes such as Xorg. The installed NVML driver library verifies whether missing SM readings mean no activity or an unsupported query; no additional Python package is needed. The GPU chart has horizontal utilization/memory controls. Memory is the used framebuffer percentage of each device's total capacity. Both modes reuse the full visible history; the separate GPU process cards are omitted. Select one or more usernames to restrict CPU curves and GPU utilization/memory totals; clear the selection to return to whole-host/device usage. The user selection is remembered locally and applies to the complete visible chart history.
- **Memory** uses `MemTotal - MemAvailable` and has its own 0–100% line chart using the same five-second cadence and five-minute history. It always shows the whole server, independent of the CPU/GPU user filter.
- **Network** shows download (RX) and upload (TX) rates for the selected interface, with automatic B/s–TiB/s units and a dynamic vertical scale. An active hardware interface is selected first; the selector also exposes virtual interfaces individually to avoid double-counting bridges/bonds and their members. Loopback is excluded. Rates use differences in Linux `/proc/net/dev` byte counters over the existing CPU sampling interval, divided by monotonic elapsed time; no extra wait or package is required. Counter resets, replaced/new interfaces and unreadable counters produce unavailable samples. Network history follows the same cadence/window as the other charts and is independent of the CPU/GPU user filter. See the [Linux interface statistics documentation](https://docs.kernel.org/networking/statistics.html).
- **Disks** use horizontal bars grouped by backing physical disks discovered through Linux sysfs. Partitions, LVM and software RAID are traced to their member disks. Multiple filesystems on one disk are combined; bind mounts are counted once. Shared storage spanning several disks is displayed as one combined disk group, without inventing per-member usage or double-counting the shared filesystem. Bars show usage of the measured mounted filesystems, accounting for reserved blocks; the full physical capacity is listed separately. Unmounted/unreadable usage shows N/A, never zero. Device names, models and mount details are expandable. Loop devices, RAM disks, optical media, network filesystems and container overlays are excluded. Unsupported Btrfs/ZFS pools are not attributed to an arbitrary member disk. Hardware RAID controllers, virtual machines and restricted containers may hide the underlying physical topology; only disks exposed by the server can be identified. Units are GiB.

The probe uses the server's saved SSH connection and host-key verification, sends fixed Python code through stdin, and does not install an agent or request sudo. It needs Linux and `/usr/bin/python3`. Read-only monitoring does not hold the account-management lock or add an audit event every refresh. Concurrent samples for one connection are bounded to one; successful samples have a three-second in-memory cache tied to the connection configuration.

Restricted `/proc` visibility, container PID namespaces, MIG/MPS and driver limitations can prevent complete per-user attribution. Unknown GPU owners are excluded from named-user filters. Unsupported metrics show **N/A**, not zero. Per-process SM samples may overlap and their sum is approximate; curves are capped at 100% while legends and tooltips retain the reported sum; it is not equivalent to the device utilization counter. When NVML confirms no non-zero process activity in the sample window, the process contributes 0% utilization even if it still holds GPU memory. Query failures and unsupported metrics remain N/A. See the [NVML process utilization API](https://docs.nvidia.com/deploy/nvml-api/api/group__nvmlDeviceQueries.html) for these sampling semantics. Missing NVIDIA tooling leaves CPU, memory and disks available. See the [NVIDIA monitoring documentation](https://docs.nvidia.com/deploy/nvidia-smi/) for device support and the [Mantine AppShell documentation](https://mantine.dev/core/app-shell/) for the page layout component.

SSH host-key verification remains enabled. Verify a new server's fingerprint and add it to the local SSH known-hosts file before testing its connection. Remote servers require Linux and Python 3; account changes also require sudo privileges.

Automated tests use temporary databases and mocked remote execution. The optional `npm run test:ssh` also exercises the real SSH transport and account lifecycle inside a disposable Linux container bound to loopback; it requires Docker and never contacts configured servers.

## Release builds

The `Desktop release` workflow builds Rust/Tauri macOS arm64/x64 and Windows x64 packages. Manual runs upload build artifacts; version tags publish only after every platform succeeds and the npm, Cargo and Tauri versions match. Builds use the committed npm and Cargo lockfiles. Packages contain the Rust executable and embedded UI/probes, with no Electron, Python, Node or Ansible runtime.

Native JSON exports and credential downloads use a save dialog. Cancelling or failing to write an export does not consume credentials. Credential exports require a new destination filename and retain owner-only file permissions on Unix.
