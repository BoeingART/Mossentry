# Server Manager

A desktop application for managing a fixed group of Linux hosts. Electron starts a local FastAPI service and opens the manager in a dedicated window. The interface includes host scan status, user accounts and sudo access, approval requests, an audit trail, and one-time credential downloads.

## Run

Requires macOS or Linux, Node.js, Python 3.12, SSH, OpenSSL, and Ansible. From the project directory:

```bash
npm install
npm run setup:backend
npm start
```

Desktop mode opens the manager without an administrator password. To run the backend checks:

```bash
npm run setup:test
npm run check
```

## Host connections

The five configured hosts and ports are defined in `backend/app/config.py`. The application looks for management keys such as `id_rsa_srvmgr-for-gpu1` in the current user's `~/.ssh` directory. Set `SRVMGR_SSH_DIR` to use another key directory. Keys must have mode `0600`. Each remote host must accept SSH connections and allow the `srvmgr` account the configured sudo access.

If sudo needs a password, put one nonempty line in `srvmgr.passwd` in the application data directory with mode `0600`, or set `SRVMGR_BECOME_PASSWORD_FILE` to another file.

Runtime data lives in the Electron user-data directory under `data`, including the database, one-time credentials, and audit records. Set `SRVMGR_USER_DATA_DIR` to choose another parent directory. Existing data from earlier builds is reused automatically when the new data directory is empty. The app deletes any legacy initial-password file when it starts in desktop mode.

The input archive `server_manager.tar.gz` is retained for reference. It includes runtime data and sensitive paths and is not unpacked into the application source. Do not distribute it with the application.

## Project layout

- `desktop/main.cjs`: Electron window, local service lifecycle, and security restrictions.
- `backend/app`: interface, API, SQLite, and application logic.
- `backend/ansible`: fixed Ansible playbooks.
- `backend/tests`: backend and desktop-mode checks.

The desktop service listens only on a random `127.0.0.1` port and requires a fresh access token on every launch. Closing the window stops the service. Do not run another backend instance against the same data directory while the desktop app is open. Direct backend use still supports password sign-in.
