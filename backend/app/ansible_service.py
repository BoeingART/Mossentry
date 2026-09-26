from __future__ import annotations

import json
import os
import random
import re
import secrets
import shutil
import stat
import string
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import ANSIBLE_DIR, DATA_DIR
from .db import connect, now, row, rows

SAFE_NAME = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
SAFE_HOST = re.compile(r"^[a-zA-Z0-9._-]+$")


@dataclass
class RunResult:
    ok: bool
    output: str


def _ansible_playbook() -> str:
    sibling = Path(sys.executable).with_name("ansible-playbook")
    executable = str(sibling) if sibling.exists() else shutil.which("ansible-playbook")
    if not executable:
        raise RuntimeError("ansible-playbook is missing. Install backend/requirements.txt first")
    return executable


def _enabled_servers() -> list[dict[str, Any]]:
    return rows("SELECT * FROM servers WHERE enabled=1 ORDER BY name")


def _inventory() -> Path:
    path = DATA_DIR / "inventory.ini"
    lines = ["[managed]"]
    for server in _enabled_servers():
        if not SAFE_HOST.fullmatch(server["hostname"]):
            raise RuntimeError(f"Host {server['name']} has an invalid address")
        lines.append(
            f"{server['name']} ansible_host={server['hostname']} ansible_port={int(server['port'])} "
            f"ansible_user={server['ssh_user']} ansible_ssh_private_key_file={server['key_path']} "
            "ansible_python_interpreter=/usr/bin/python3"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path


def _become_password() -> str | None:
    password_path = Path(os.environ.get("SRVMGR_BECOME_PASSWORD_FILE", DATA_DIR / "srvmgr.passwd"))
    if not password_path.exists():
        return None
    mode = stat.S_IMODE(password_path.stat().st_mode)
    if mode & 0o077:
        raise RuntimeError(f"The sudo password file must have mode 600; current mode is {mode:o}")
    password = password_path.read_text(encoding="utf-8").rstrip("\r\n")
    if not password or "\n" in password or "\r" in password or "\x00" in password:
        raise RuntimeError("The sudo password file must contain exactly one nonempty line")
    return password


def _run(playbook: str, limit: str, extra: dict[str, Any] | None = None, timeout: int = 180) -> RunResult:
    valid_servers = {s["name"] for s in _enabled_servers()}
    selected = set(limit.split(","))
    if not selected or not selected <= valid_servers:
        raise ValueError("Target host is not in the inventory")
    inventory = _inventory()
    command = [
        _ansible_playbook(), "-i", str(inventory), str(ANSIBLE_DIR / playbook),
        "--limit", limit,
    ]
    extra_path: Path | None = None
    effective_extra = dict(extra or {})
    become_password = _become_password()
    if become_password is not None:
        effective_extra["ansible_become_password"] = become_password
    if effective_extra:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", dir=DATA_DIR / "jobs", delete=False)
        json.dump(effective_extra, handle, ensure_ascii=False)
        handle.close()
        extra_path = Path(handle.name)
        extra_path.chmod(0o600)
        command.extend(["--extra-vars", f"@{extra_path}"])
    env = os.environ.copy()
    local_tmp = DATA_DIR / "jobs" / "ansible-local"
    control_dir = DATA_DIR / "jobs" / "ssh-control"
    local_tmp.mkdir(mode=0o700, exist_ok=True)
    control_dir.mkdir(mode=0o700, exist_ok=True)
    env.update({
        "ANSIBLE_HOST_KEY_CHECKING": "True",
        "ANSIBLE_RETRY_FILES_ENABLED": "False",
        "ANSIBLE_NOCOLOR": "True",
        "ANSIBLE_DISPLAY_SKIPPED_HOSTS": "False",
        "ANSIBLE_LOCAL_TEMP": str(local_tmp),
        "ANSIBLE_SSH_CONTROL_PATH_DIR": str(control_dir),
    })
    try:
        completed = subprocess.run(
            command, cwd=ANSIBLE_DIR.parent, env=env, capture_output=True,
            text=True, timeout=timeout, check=False,
        )
        output = (completed.stdout + "\n" + completed.stderr).strip()
        return RunResult(completed.returncode == 0, output[-12000:])
    except subprocess.TimeoutExpired as exc:
        return RunResult(False, f"Execution timed out after {timeout} seconds.\n{exc.stdout or ''}")
    finally:
        if extra_path:
            extra_path.unlink(missing_ok=True)


def _parse_scan(name: str, raw: dict[str, Any]) -> list[dict[str, Any]]:
    sudo_members: set[str] = set()
    for group_line in (raw.get("sudo", ""), raw.get("wheel", "")):
        parts = group_line.strip().split(":")
        if len(parts) >= 4 and parts[3]:
            sudo_members.update(item for item in parts[3].split(",") if item)
    effective_sudo = set(raw.get("effective_sudo", "").splitlines())
    result = []
    for line in raw.get("passwd", "").splitlines():
        parts = line.split(":")
        if len(parts) != 7:
            continue
        username, _, uid, gid, _, home, shell = parts
        if username == "nobody":
            continue
        try:
            uid_num, gid_num = int(uid), int(gid)
        except ValueError:
            continue
        # Human accounts plus root and the automation account are useful to administrators.
        if uid_num < 1000 and username not in {"root", "srvmgr"}:
            continue
        disabled_shell = shell.endswith(("/nologin", "/false"))
        result.append({
            "server": name, "username": username, "uid": uid_num, "gid": gid_num,
            "home": home, "shell": shell,
            "is_sudo": username in sudo_members or username in effective_sudo or username == "root",
            # A locked password is normal in this key-only environment and does
            # not block SSH public-key authentication. nologin/false does.
            "is_disabled": disabled_shell,
        })
    return result


def scan_servers(server_names: list[str] | None = None) -> tuple[list[dict[str, Any]], dict[str, str]]:
    selected = server_names or [s["name"] for s in _enabled_servers()]
    job_dir = Path(tempfile.mkdtemp(prefix="scan-", dir=DATA_DIR / "jobs"))
    try:
        result = _run("scan_users.yml", ",".join(selected), {"scan_output_dir": str(job_dir)}, timeout=120)
        users: list[dict[str, Any]] = []
        errors: dict[str, str] = {}
        scanned_at = now()
        with connect() as conn:
            for name in selected:
                server = conn.execute("SELECT * FROM servers WHERE name=?", (name,)).fetchone()
                output_file = job_dir / f"{name}.json"
                if output_file.exists():
                    parsed = _parse_scan(name, json.loads(output_file.read_text(encoding="utf-8")))
                    users.extend(parsed)
                    conn.execute("DELETE FROM server_users WHERE server_id=?", (server["id"],))
                    conn.executemany(
                        """INSERT INTO server_users(server_id,username,uid,gid,home,shell,is_sudo,is_disabled,scanned_at)
                        VALUES(?,?,?,?,?,?,?,?,?)""",
                        [
                            (server["id"], u["username"], u["uid"], u["gid"], u["home"], u["shell"],
                             int(u["is_sudo"]), int(u["is_disabled"]), scanned_at)
                            for u in parsed
                        ],
                    )
                    conn.execute(
                        "UPDATE servers SET last_scan_at=?,last_scan_status='ok',last_scan_error=NULL WHERE id=?",
                        (scanned_at, server["id"]),
                    )
                else:
                    error = _host_error(result.output, name)
                    errors[name] = error
                    conn.execute(
                        "UPDATE servers SET last_scan_at=?,last_scan_status='error',last_scan_error=? WHERE id=?",
                        (scanned_at, error, server["id"]),
                    )
        return users, errors
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def _host_error(output: str, name: str) -> str:
    matching = [line.strip() for line in output.splitlines() if name in line and ("FAILED" in line or "UNREACHABLE" in line)]
    fallback = "\n".join(output.splitlines()[-8:]).strip() or "Scan returned no result"
    return (matching[-1] if matching else fallback)[-1000:]


def _generate_key(action_id: int, username: str) -> tuple[Path, str, str]:
    key_dir = DATA_DIR / "keys"
    private_path = key_dir / f"action-{action_id}-{username}"
    if private_path.exists() or private_path.with_suffix(".pub").exists():
        raise RuntimeError("Key file already exists; refusing to overwrite it")
    completed = subprocess.run(
        ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"{username}@server-manager/action-{action_id}", "-f", str(private_path)],
        capture_output=True, text=True, timeout=20, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "Could not generate the SSH key")
    private_path.chmod(0o600)
    public_path = private_path.with_suffix(".pub")
    public_key = public_path.read_text(encoding="utf-8").strip()
    fingerprint = subprocess.run(
        ["ssh-keygen", "-lf", str(public_path)], capture_output=True, text=True, check=True, timeout=10,
    ).stdout.split()[1]
    public_path.unlink(missing_ok=True)
    return private_path, public_key, fingerprint


def _generate_initial_password(length: int = 16) -> str:
    if length < 2:
        raise ValueError("Password must contain at least 2 characters")
    characters = [
        secrets.choice(string.ascii_letters),
        secrets.choice(string.digits),
        *(secrets.choice(string.ascii_letters + string.digits) for _ in range(length - 2)),
    ]
    random.SystemRandom().shuffle(characters)
    return "".join(characters)


def _password_hash(password: str) -> str:
    completed = subprocess.run(
        ["openssl", "passwd", "-6", "-salt", secrets.token_hex(8), "-stdin"],
        input=password + "\n", capture_output=True, text=True, timeout=10, check=False,
    )
    password_hash = completed.stdout.strip()
    if completed.returncode != 0 or not password_hash.startswith("$6$"):
        raise RuntimeError(completed.stderr.strip() or "Could not hash the user password")
    return password_hash


def _zip_entry(name: str) -> zipfile.ZipInfo:
    entry = zipfile.ZipInfo(name)
    entry.create_system = 3
    entry.compress_type = zipfile.ZIP_DEFLATED
    entry.external_attr = (stat.S_IFREG | 0o600) << 16
    return entry


def _login_instructions(username: str, password: str, server_names: list[str], key_name: str) -> str:
    server_by_name = {server["name"]: server for server in rows(
        f"SELECT name,hostname,port FROM servers WHERE name IN ({','.join('?' for _ in server_names)})",
        tuple(server_names),
    )}
    if set(server_names) != set(server_by_name):
        raise RuntimeError("Cannot generate sign-in instructions: host information is incomplete")
    commands = [
        f"ssh {username}@{server_by_name[name]['hostname']} -p {server_by_name[name]['port']} -i {key_name}"
        for name in server_names
    ]
    login = commands[0] if len(commands) == 1 else "\n" + "\n".join(commands)
    return f"""Username: {username}

Password: {password}

Sign-in: {login}


Important notes

1. The 16-character alphanumeric password should be saved immediately. Use passwd to change it after signing in.
2. The public key has been added to ~/.ssh/authorized_keys. The host currently supports key-based sign-in only.
3. To use your own key, copy your public key into ~/.ssh/authorized_keys after signing in.
4. For more host information, see https://gitlab.deepsynthesis.top/root/gitlab-mannual/-/blob/main/服务器登录指南.md
"""


def _build_credentials_archive(
    action_id: int, username: str, password: str, server_names: list[str], private_path: Path,
) -> Path:
    archive_path = private_path.parent / f"action-{action_id}-{username}-login.zip"
    if archive_path.exists():
        raise RuntimeError("Credentials file already exists; refusing to overwrite it")
    key_name = f"{username}-server-ed25519"
    instructions = _login_instructions(username, password, server_names, key_name)
    try:
        private_key = private_path.read_bytes()
        with zipfile.ZipFile(archive_path, "x") as archive:
            archive.writestr(_zip_entry(key_name), private_key)
            archive.writestr(_zip_entry("login-instructions.txt"), instructions.encode("utf-8"))
        archive_path.chmod(0o600)
        return archive_path
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise


def execute_action(action_id: int) -> RunResult:
    action = row("SELECT * FROM actions WHERE id=?", (action_id,))
    if not action or action["status"] != "approved":
        raise ValueError("Request does not exist or cannot be run in its current state")
    payload = json.loads(action["payload_json"])
    username = action["target_user"]
    if not SAFE_NAME.fullmatch(username):
        raise ValueError("Invalid username")
    servers = payload["servers"]
    extra: dict[str, Any] = {"managed_username": username}
    private_path: Path | None = None
    download_path: Path | None = None
    try:
        preflight = _run("preflight.yml", ",".join(servers), timeout=45)
        if not preflight.ok:
            with connect() as conn:
                conn.execute(
                    "UPDATE actions SET status='failed',executed_at=?,error=? WHERE id=?",
                    (now(), "Preflight permission check failed:\n" + preflight.output, action_id),
                )
            return preflight
        if action["action_type"] == "create_user":
            private_path, public_key, fingerprint = _generate_key(action_id, username)
            password = _generate_initial_password()
            download_path = _build_credentials_archive(
                action_id, username, password, servers, private_path,
            )
            private_path.unlink()
            private_path = None
            extra.update({
                "managed_public_key": public_key,
                "managed_password_hash": _password_hash(password),
                "managed_sudo": bool(payload.get("sudo")),
                "managed_comment": payload.get("full_name", ""),
            })
            result = _run("create_user.yml", ",".join(servers), extra)
            if result.ok:
                with connect() as conn:
                    conn.execute(
                        """UPDATE actions SET status='executed',executed_at=?,public_key=?,key_fingerprint=?,private_key_path=?
                        WHERE id=?""",
                        (now(), public_key, fingerprint, str(download_path), action_id),
                    )
                return result
        elif action["action_type"] == "disable_user":
            result = _run("disable_user.yml", ",".join(servers), extra)
        elif action["action_type"] == "enable_user":
            result = _run("enable_user.yml", ",".join(servers), extra)
        elif action["action_type"] == "set_sudo":
            extra["managed_sudo"] = bool(payload["sudo"])
            result = _run("set_sudo.yml", ",".join(servers), extra)
        else:
            raise ValueError("Unknown action type")
        with connect() as conn:
            conn.execute(
                "UPDATE actions SET status=?,executed_at=?,error=? WHERE id=?",
                ("executed" if result.ok else "failed", now(), None if result.ok else result.output, action_id),
            )
        return result
    except Exception:
        if private_path:
            private_path.unlink(missing_ok=True)
        if download_path:
            download_path.unlink(missing_ok=True)
        raise
    finally:
        # Failed operations never leave a downloadable private key behind.
        current = row("SELECT status FROM actions WHERE id=?", (action_id,))
        if private_path and (not current or current["status"] != "executed"):
            private_path.unlink(missing_ok=True)
        if download_path and (not current or current["status"] != "executed"):
            download_path.unlink(missing_ok=True)
