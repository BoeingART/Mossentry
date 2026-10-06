"""Read-only creation-time probe run as root by the existing Ansible scan.

Only uses the Python standard library and existing Linux commands. Input is
the scan's passwd snapshot; output contains metadata for those same accounts.
"""
import glob
import json
import os
import re
import subprocess
import sys
from datetime import datetime


ISO_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))(?=\s|$)")
SYSLOG_TIME = re.compile(r"^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})(?=\s|$)")
NEW_USER = re.compile(r"\buseradd(?:\[\d+\])?:\s+new user:\s*(.*)$")


def command_output(argv):
    # Missing tools, unreadable/expired logs and unsupported birth times are
    # optional metadata failures, not failures of the account sync itself.
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                universal_newlines=True, timeout=20, check=False,
                                encoding="utf-8", errors="replace",
                                env=dict(os.environ, LC_ALL="C"))
    except (OSError, subprocess.TimeoutExpired):
        return ""
    # zgrep/stat can fail for one path after reading others successfully.
    return result.stdout if result.returncode == 0 or argv[0] in {"zgrep", "stat"} else ""


def iso_timestamp(value):
    match = ISO_TIME.match(value)
    if not match:
        return None
    value = match.group(1)
    value = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", value)
    # Validate without losing nanosecond precision in stat's original value.
    check = re.sub(r"(\.\d{6})\d+", r"\1", value).replace("Z", "+00:00")
    fmt = "%Y-%m-%dT%H:%M:%S" + (".%f" if "." in check else "") + "%z"
    try:
        datetime.strptime(check, fmt)
    except ValueError:
        return None
    return value


def timestamp(line):
    iso = iso_timestamp(line)
    if iso:
        return iso
    match = SYSLOG_TIME.match(line)
    if match:
        value = " ".join(match.group(1).split())
        try:
            # Validate against a leap year; never invent a year for storage.
            datetime.strptime("2000 " + value, "%Y %b %d %H:%M:%S")
        except ValueError:
            return None
        return value
    return None


def parse_logs(output, accounts):
    found = {}
    for line in output.splitlines():
        match = NEW_USER.search(line)
        if not match:
            continue
        fields = dict(part.strip().split("=", 1) for part in match.group(1).split(",") if "=" in part)
        name = fields.get("name")
        account = accounts.get(name)
        if not account or fields.get("UID") != str(account["uid"]):
            continue
        if fields.get("home") and fields["home"] != account["home"]:
            continue
        value = timestamp(line)
        if value:
            # Commands supply files/entries oldest first. A reused name/UID
            # refers to the latest creation, not its deleted predecessor.
            found[name] = value
    return found


def auth_files():
    # Current log, numbered rotations and compressed rotations are read in
    # chronological rotation order, independently of glob's lexical order.
    def rotation(path):
        suffix = path[len("/var/log/auth.log"):]
        match = re.match(r"\.(\d+)(?:\.gz)?$", suffix)
        return int(match.group(1)) if match else 0
    return sorted(glob.glob("/var/log/auth.log*"), key=rotation, reverse=True)


def collect(passwd):
    accounts = {}
    for line in passwd.splitlines():
        parts = line.split(":")
        if len(parts) != 7:
            continue
        try:
            uid = int(parts[2])
        except ValueError:
            continue
        accounts[parts[0]] = {"uid": uid, "home": parts[5]}
    if not accounts:
        return {}

    files = auth_files()
    auth = parse_logs(command_output(["zgrep", "-h", "new user:", "--"] + files), accounts) if files else {}
    need_journal = {name for name in accounts if name not in auth or not iso_timestamp(auth[name])}
    journal = {}
    if need_journal:
        journal = parse_logs(command_output(["journalctl", "-t", "useradd", "--no-pager", "-o", "short-iso"]), accounts)

    found = {}
    missing = {}
    for name, account in accounts.items():
        value, source = auth.get(name), "auth_log"
        if name in need_journal and name in journal:
            value, source = journal[name], "journal"
        if value:
            found[name] = {"created_at": value, "source": source}
        elif os.path.isabs(account["home"]):
            missing[name] = account["home"]

    # Batch stat calls; use the account's actual home (including /root or
    # custom locations), and %w rather than inode change/modification time.
    if missing:
        homes = list(dict.fromkeys(missing.values()))
        births = {}
        for line in command_output(["stat", "-c", "%n\t%w", "--"] + homes).splitlines():
            home, separator, value = line.rpartition("\t")
            if separator:
                value = iso_timestamp(value.replace(" ", "T", 1).replace(" ", ""))
                if value:
                    births[home] = value
        for name, home in missing.items():
            if home in births:
                found[name] = {"created_at": births[home], "source": "home_birth"}
    return found


if __name__ == "__main__":
    print(json.dumps(collect(sys.stdin.read())))
