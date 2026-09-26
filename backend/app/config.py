from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SRVMGR_DATA_DIR", BASE_DIR / "data")).resolve()
DB_PATH = Path(os.environ.get("SRVMGR_DB_PATH", DATA_DIR / "server_manager.db")).resolve()
ANSIBLE_DIR = BASE_DIR / "ansible"
SSH_DIR = Path(os.environ.get("SRVMGR_SSH_DIR", Path.home() / ".ssh")).resolve()

SESSION_HOURS = int(os.environ.get("SRVMGR_SESSION_HOURS", "12"))
COOKIE_SECURE = os.environ.get("SRVMGR_COOKIE_SECURE", "false").lower() == "true"

DEFAULT_SERVERS = (
    ("gpu1", "server.luo-group.com", 10901, 10000, 10999, "srvmgr", SSH_DIR / "id_rsa_srvmgr-for-gpu1"),
    ("gpu2", "server.luo-group.com", 11901, 11000, 11999, "srvmgr", SSH_DIR / "id_rsa_srvmgr-for-gpu2"),
    ("gpu3", "server.luo-group.com", 12901, 12000, 12999, "srvmgr", SSH_DIR / "id_rsa_srvmgr-for-gpu3"),
    ("gpu4", "server.luo-group.com", 13901, 13000, 13999, "srvmgr", SSH_DIR / "id_rsa_srvmgr-for-gpu4"),
    ("cpu1", "server.luo-group.com", 20901, 20000, 20999, "srvmgr", SSH_DIR / "id_rsa_srvmgr-for-cpu1"),
)
