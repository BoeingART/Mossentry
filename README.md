# Server Manager

Electron desktop application for managing Linux servers over SSH. The interface uses React, Mantine, and TypeScript. A local FastAPI service handles host scans, access requests, approvals, audit events, and one-time credential downloads.

## Run

Requires macOS or Linux, Node.js, Python 3.12, SSH, OpenSSL, and Ansible.

```bash
npm install
npm run setup:backend
npm start
```

`npm start` builds the React interface and launches Electron. Desktop mode opens without an administrator password. To run the project checks:

```bash
npm run setup:test
npm run check
```

## Development

`frontend/src` contains the React interface and typed API client. `npm run build` writes the production interface to `backend/app/frontend`, where FastAPI serves it to Electron. That generated directory is ignored by Git.

The backend can also run directly after building the interface:

```bash
cd backend
../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

For interface development, run `npm run dev:ui` in another terminal; Vite proxies `/api` to port 8000. Direct backend use supports administrator password sign-in.

## Host connections and data

Add, edit, pause, or remove servers from the **Servers** page. The five hosts in `backend/app/config.py` seed new installations once; subsequent changes live in SQLite, and removed hosts stay removed after restart. The connection form accepts a hostname or IPv4/IPv6 address, SSH port, login account and an absolute or `~/` private-key path. The default management key is `~/.ssh/id_rsa`; existing servers keep their saved key paths. Set `SRVMGR_SSH_DIR` to use another key directory for the initial server inventory. Keys must have mode `0600`. Each remote host must accept SSH and grant the `srvmgr` account the configured sudo access.

If sudo needs a password, put one nonempty line in `srvmgr.passwd` in the application data directory with mode `0600`, or set `SRVMGR_BECOME_PASSWORD_FILE` to another file.

Runtime data lives under `data` in the Electron user-data directory. Set `SRVMGR_USER_DATA_DIR` to choose another parent directory. Existing data from earlier builds is reused automatically when the new data directory is empty.

SSH connection-reuse sockets use a private temporary directory under `/tmp`, removed after each operation. This keeps socket paths within macOS limits even when the application data directory has a long name.

The input archive `server_manager.tar.gz` is retained for reference. It includes runtime data and sensitive paths and must not be distributed with the application.

## Layout

- `desktop/main.cjs`: Electron window, local service lifecycle, and access restrictions.
- `frontend/src`: React and Mantine interface.
- `backend/app`: FastAPI routes, SQLite, and application logic.
- `backend/ansible`: fixed Ansible playbooks.
- `backend/tests`: backend and desktop-mode checks.

The desktop service listens only on a random `127.0.0.1` port and requires a fresh access token on every launch. Closing the window stops the service. Do not run another backend instance against the same data directory while the desktop app is open.

## Management workflows

- **Servers**: test a single SSH connection, sync its accounts, or read uptime, load, memory and root-disk usage. **Sync all** refreshes enabled servers. Pausing a server excludes it from remote operations.
- **Users & access**: filter by server, create accounts, enable/disable interactive login, grant/revoke sudo membership, edit local display names, and request account deletion. Deletion requires typing the username and approval, keeps the home directory and files, and does not force-terminate sessions. System accounts and SSH management accounts are protected locally and checked again on the remote host.
- Pending requests must be handled before a server can be edited or removed. Removing a server removes only its local configuration and cached account list; remote accounts and files and local operation history are retained. Connection changes invalidate cached accounts. Remote operations are serialized with configuration changes.
- The interface shows short error explanations. Raw management execution details remain in the local database for troubleshooting. Failed syncs identify saved account data as potentially stale. **Status** remains a point-in-time snapshot; **Monitor** opens a dedicated resource monitoring page.

## Monitor pages

Open **Monitor** in the left navigation to see the server list. Each **Open monitor** button opens that server's main monitoring page; **Monitor** on a Servers card goes directly to the same detail page. **All monitors** returns to the list. Both desktop and narrow windows use the main content area.

CPU, GPU and Memory have two-dimensional line charts with a fixed **0–100%** vertical axis and a rolling **5-minute** horizontal time axis. Each GPU has its own line. Samples start every **5 seconds**, rather than five seconds after the previous response. A slow request skips overlapping ticks. Collection stops while paused, hidden, or on another page. Ordinary failures retry on the same five-second cadence; authentication failures require resuming or reopening after signing in. Missing/unsupported samples leave gaps, and older samples move out of the window. History accumulates while a server detail page is open; opening another server starts a separate history. Charts use local sample receipt time to avoid differences between server and desktop clocks.

- **CPU** shows a one-second `/proc` counter difference, a recent-sample trend, and optional filtering by effective process owner. The separate CPU-by-user table is omitted. Percentages use the whole host's logical CPU capacity (100% means all CPUs). Processes that disappear during the sample, or whose ownership changes, may be omitted.
- **GPU** supports NVIDIA hosts with `nvidia-smi`. Each device reports utilization, temperature and framebuffer usage. Per-process SM utilization and framebuffer memory come from `pmon`, including graphics processes such as Xorg. The installed NVML driver library verifies whether missing SM readings mean no activity or an unsupported query; no additional Python package is needed. Select one or more usernames to restrict CPU curves and GPU process rows and totals; clear the selection to return to whole-host/device usage. The user selection is remembered locally and applies to the complete visible chart history.
- **Memory** uses `MemTotal - MemAvailable` and has its own 0–100% line chart using the same five-second cadence and five-minute history. It always shows the whole server, independent of the CPU/GPU user filter.
- **Disks** use horizontal bars grouped by backing physical disks discovered through Linux sysfs. Partitions, LVM and software RAID are traced to their member disks. Multiple filesystems on one disk are combined; bind mounts are counted once. Shared storage spanning several disks is displayed as one combined disk group, without inventing per-member usage or double-counting the shared filesystem. Bars show usage of the measured mounted filesystems, accounting for reserved blocks; the full physical capacity is listed separately. Unmounted/unreadable usage shows N/A, never zero. Device names, models and mount details are expandable. Loop devices, RAM disks, optical media, network filesystems and container overlays are excluded. Unsupported Btrfs/ZFS pools are not attributed to an arbitrary member disk. Hardware RAID controllers, virtual machines and restricted containers may hide the underlying physical topology; only disks exposed by the server can be identified. Units are GiB.

The probe uses the server's saved SSH connection and host-key verification, sends fixed Python code through stdin, and does not install an agent or request sudo. It needs Linux and `/usr/bin/python3`. Read-only monitoring does not hold the account-management lock or add an audit event every refresh. Concurrent samples for one connection are bounded to one; successful samples have a three-second in-memory cache tied to the connection configuration.

Restricted `/proc` visibility, container PID namespaces, MIG/MPS and driver limitations can prevent complete per-user attribution. Unknown GPU owners are shown explicitly and excluded from named-user filters. Unsupported metrics show **N/A**, not zero. Per-process SM samples may overlap and their sum is approximate; curves are capped at 100% while legends and tooltips retain the reported sum; it is not equivalent to the device utilization counter. When NVML confirms no non-zero process activity in the sample window, the process shows 0% with an idle explanation even if it still holds GPU memory. Query failures and unsupported metrics remain N/A. See the [NVML process utilization API](https://docs.nvidia.com/deploy/nvml-api/api/group__nvmlDeviceQueries.html) for these sampling semantics. Missing NVIDIA tooling leaves CPU, memory and disks available. See the [NVIDIA monitoring documentation](https://docs.nvidia.com/deploy/nvidia-smi/) for device support and the [Mantine AppShell documentation](https://mantine.dev/core/app-shell/) for the page layout component.

SSH host-key verification remains enabled. Verify a new server's fingerprint and add it to the local SSH known-hosts file before testing its connection. Remote servers require Linux and Python 3; account changes also require sudo privileges.

Automated tests use temporary databases and mocked remote execution; they never change accounts on configured servers.
