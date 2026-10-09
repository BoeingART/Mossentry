from __future__ import annotations

import os
from pathlib import Path


def setting(name: str, default=None):
    """Read Mossentry configuration, accepting the previous SRVMGR prefix."""
    return os.environ.get(f"MOSSENTRY_{name}", os.environ.get(f"SRVMGR_{name}", default))


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(setting("DATA_DIR", BASE_DIR / "data")).resolve()
# Reuse the existing database in place, including any SQLite WAL sidecars.
DEFAULT_DB_PATH = DATA_DIR / "mossentry.db"
if not DEFAULT_DB_PATH.exists() and (DATA_DIR / "server_manager.db").exists():
    DEFAULT_DB_PATH = DATA_DIR / "server_manager.db"
DB_PATH = Path(setting("DB_PATH", DEFAULT_DB_PATH)).resolve()
ANSIBLE_DIR = BASE_DIR / "ansible"
SSH_DIR = Path(setting("SSH_DIR", Path.home() / ".ssh")).resolve()

SESSION_HOURS = int(setting("SESSION_HOURS", "12"))
COOKIE_SECURE = setting("COOKIE_SECURE", "false").lower() == "true"

DEFAULT_SERVERS = (
    ("gpu1", "server.luo-group.com", 10901, "srvmgr", SSH_DIR / "id_rsa"),
    ("gpu2", "server.luo-group.com", 11901, "srvmgr", SSH_DIR / "id_rsa"),
    ("gpu3", "server.luo-group.com", 12901, "srvmgr", SSH_DIR / "id_rsa"),
    ("gpu4", "server.luo-group.com", 13901, "srvmgr", SSH_DIR / "id_rsa"),
    ("cpu1", "server.luo-group.com", 20901, "srvmgr", SSH_DIR / "id_rsa"),
)
