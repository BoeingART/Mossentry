# Server Manager

Electron desktop application for managing a fixed group of Linux hosts. The interface uses React, Mantine, and TypeScript. A local FastAPI service handles host scans, access requests, approvals, audit events, and one-time credential downloads.

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

The five configured hosts and ports are defined in `backend/app/config.py`. Management keys such as `id_rsa_srvmgr-for-gpu1` are read from `~/.ssh`; set `SRVMGR_SSH_DIR` to use another directory. Keys must have mode `0600`. Each remote host must accept SSH and grant the `srvmgr` account the configured sudo access.

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
