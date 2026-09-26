from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

from .config import DATA_DIR, DB_PATH, DEFAULT_SERVERS, SESSION_HOURS
from .security import hash_password, token


def now() -> str:
    return datetime.now(UTC).isoformat()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL,
  public_port_start INTEGER,
  public_port_end INTEGER,
  ssh_user TEXT NOT NULL,
  key_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scan_at TEXT,
  last_scan_status TEXT NOT NULL DEFAULT 'never',
  last_scan_error TEXT
);
CREATE TABLE IF NOT EXISTS server_users (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  uid INTEGER NOT NULL,
  gid INTEGER NOT NULL,
  home TEXT NOT NULL,
  shell TEXT NOT NULL,
  is_sudo INTEGER NOT NULL,
  is_disabled INTEGER NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (server_id, username)
);
CREATE TABLE IF NOT EXISTS user_profiles (
  username TEXT PRIMARY KEY,
  full_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES admins(id)
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  action_type TEXT NOT NULL,
  target_server TEXT NOT NULL,
  target_user TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER NOT NULL REFERENCES admins(id),
  approved_by INTEGER REFERENCES admins(id),
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  executed_at TEXT,
  error TEXT,
  public_key TEXT,
  key_fingerprint TEXT,
  private_key_path TEXT,
  key_downloaded_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES admins(id),
  event TEXT NOT NULL,
  target TEXT,
  details_json TEXT NOT NULL,
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_server_users_username ON server_users(username);
CREATE INDEX IF NOT EXISTS idx_actions_status_requested ON actions(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
"""


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "jobs").mkdir(mode=0o700, exist_ok=True)
    (DATA_DIR / "keys").mkdir(mode=0o700, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        server_columns = {item[1] for item in conn.execute("PRAGMA table_info(servers)")}
        if "public_port_start" not in server_columns:
            conn.execute("ALTER TABLE servers ADD COLUMN public_port_start INTEGER")
        if "public_port_end" not in server_columns:
            conn.execute("ALTER TABLE servers ADD COLUMN public_port_end INTEGER")
        for name, hostname, port, public_port_start, public_port_end, ssh_user, key_path in DEFAULT_SERVERS:
            conn.execute(
                """INSERT INTO servers(
                    name, hostname, port, public_port_start, public_port_end, ssh_user, key_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING""",
                (name, hostname, port, public_port_start, public_port_end, ssh_user, str(key_path)),
            )
        conn.execute("PRAGMA optimize")
        count = conn.execute("SELECT COUNT(*) FROM admins").fetchone()[0]
        desktop_mode = bool(os.environ.get("SRVMGR_DESKTOP_TOKEN"))
        if count == 0:
            password = token() if desktop_mode else (os.environ.get("SRVMGR_ADMIN_PASSWORD") or token()[:20])
            conn.execute(
                "INSERT INTO admins(username, password_hash, created_at) VALUES (?, ?, ?)",
                (os.environ.get("SRVMGR_ADMIN_USER", "admin"), hash_password(password), now()),
            )
            if not desktop_mode:
                password_file = DATA_DIR / "initial_admin_password"
                password_file.write_text(password + "\n", encoding="utf-8")
                password_file.chmod(0o600)
    if desktop_mode:
        (DATA_DIR / "initial_admin_password").unlink(missing_ok=True)


def rows(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with connect() as conn:
        return [dict(row) for row in conn.execute(query, params).fetchall()]


def row(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    result = rows(query, params)
    return result[0] if result else None


def execute(query: str, params: tuple[Any, ...] = ()) -> int:
    with connect() as conn:
        cursor = conn.execute(query, params)
        return int(cursor.lastrowid or 0)


def audit(actor_id: int | None, event: str, target: str | None, details: dict[str, Any], ip: str | None) -> None:
    execute(
        "INSERT INTO audit_log(actor_id,event,target,details_json,ip_address,created_at) VALUES(?,?,?,?,?,?)",
        (actor_id, event, target, json.dumps(details, ensure_ascii=False), ip, now()),
    )


def create_session(admin_id: int) -> tuple[str, str]:
    session_id, csrf = token(), token()
    expires = (datetime.now(UTC) + timedelta(hours=SESSION_HOURS)).isoformat()
    execute(
        "INSERT INTO sessions(id,admin_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
        (session_id, admin_id, csrf, expires, now()),
    )
    return session_id, csrf


def get_session(session_id: str | None) -> dict[str, Any] | None:
    if not session_id:
        return None
    return row(
        """SELECT s.*, a.username FROM sessions s JOIN admins a ON a.id=s.admin_id
        WHERE s.id=? AND s.expires_at>? AND a.active=1""",
        (session_id, now()),
    )
