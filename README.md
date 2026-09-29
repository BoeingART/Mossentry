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

Add, edit, pause, or remove servers from the **Servers** page. The five hosts in `backend/app/config.py` seed new installations once; subsequent changes live in SQLite, and removed hosts stay removed after restart. The connection form accepts a hostname or IPv4/IPv6 address, SSH port, login account and an absolute or `~/` private-key path. Management keys such as `id_rsa_srvmgr-for-gpu1` are read from `~/.ssh`; set `SRVMGR_SSH_DIR` to use another directory. Keys must have mode `0600`. Each remote host must accept SSH and grant the `srvmgr` account the configured sudo access.

If sudo needs a password, put one nonempty line in `srvmgr.passwd` in the application data directory with mode `0600`, or set `SRVMGR_BECOME_PASSWORD_FILE` to another file.

Runtime data lives under `data` in the Electron user-data directory. Set `SRVMGR_USER_DATA_DIR` to choose another parent directory. Existing data from earlier builds is reused automatically when the new data directory is empty.

The input archive `server_manager.tar.gz` is retained for reference. It includes runtime data and sensitive paths and must not be distributed with the application.

## Layout

- `desktop/main.cjs`: Electron window, local service lifecycle, and access restrictions.
- `frontend/src`: React and Mantine interface.
- `backend/app`: FastAPI routes, SQLite, and application logic.
- `backend/ansible`: fixed Ansible playbooks.
- `backend/tests`: backend and desktop-mode checks.

The desktop service listens only on a random `127.0.0.1` port and requires a fresh access token on every launch. Closing the window stops the service. Do not run another backend instance against the same data directory while the desktop app is open.

## Management workflows

- **Servers**: test a single SSH connection, sync its accounts, or read uptime, load, memory and root-disk usage. **Sync all** refreshes enabled servers. Pausing a server excludes it from remote operations. Public port ranges are optional reference information, not firewall rules.
- **Users & access**: filter by server, create accounts, enable/disable interactive login, grant/revoke sudo membership, edit local display names, and request account deletion. Deletion requires typing the username and approval, keeps the home directory and files, and does not force-terminate sessions. System accounts and SSH management accounts are protected locally and checked again on the remote host.
- Pending requests must be handled before a server can be edited or removed. Removing a server removes only its local configuration and cached account list; remote accounts and files and local operation history are retained. Connection changes invalidate cached accounts. Remote operations are serialized with configuration changes.
- The interface shows short error explanations. Raw execution details remain in the local database for troubleshooting. Failed syncs identify saved account data as potentially stale. Server status is a point-in-time snapshot, not continuous monitoring.

SSH host-key verification remains enabled. Verify a new server's fingerprint and add it to the local SSH known-hosts file before testing its connection. Remote servers require Linux and Python 3; account changes also require sudo privileges.

Automated tests use temporary databases and mocked remote execution; they never change accounts on configured servers.
