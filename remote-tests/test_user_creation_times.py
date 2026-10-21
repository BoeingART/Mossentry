import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "user_creation_times", Path(__file__).resolve().parents[1] / "src-tauri" / "remote" / "user_creation_times.py",
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

PASSWD = "alice:x:1001:1001::/home/alice:/bin/bash\nbob:x:1002:1002::/srv/bob:/bin/bash\n"


def log(name, uid, home, time="2025-08-09T10:11:12+0800"):
    return f"{time} host useradd[123]: new user: name={name}, UID={uid}, GID={uid}, home={home}, shell=/bin/bash"


class CreationTimeProbeTests(unittest.TestCase):
    def test_auth_priority_journal_fallback_and_matching_current_identity(self):
        auth = log("alice", 1001, "/home/alice") + "\n" + log("bob", 9999, "/srv/bob")
        journal = log("alice", 1001, "/home/alice", "2024-01-01T00:00:00Z") + "\n" + log("bob", 1002, "/srv/bob")
        with patch.object(probe, "auth_files", return_value=["/var/log/auth.log.1.gz", "/var/log/auth.log"]), \
             patch.object(probe, "command_output", side_effect=[auth, journal]) as run:
            result = probe.collect(PASSWD)
        self.assertEqual(result["alice"], {"created_at": "2025-08-09T10:11:12+08:00", "source": "auth_log"})
        self.assertEqual(result["bob"]["source"], "journal")
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0].args[0][:5], ["zgrep", "-h", "new user:", "--", "/var/log/auth.log.1.gz"])

    def test_yearless_auth_prefers_journal_and_never_invents_a_year(self):
        auth = log("alice", 1001, "/home/alice", "Aug  9 10:11:12")
        for journal, expected, source in (
            (log("alice", 1001, "/home/alice"), "2025-08-09T10:11:12+08:00", "journal"),
            ("", "Aug 9 10:11:12", "auth_log"),
        ):
            with self.subTest(journal=journal), patch.object(probe, "auth_files", return_value=["/var/log/auth.log"]), \
                 patch.object(probe, "command_output", side_effect=[auth, journal]):
                result = probe.collect(PASSWD.splitlines()[0])["alice"]
                self.assertEqual(result, {"created_at": expected, "source": source})

    def test_birth_time_uses_actual_home_and_preserves_precision(self):
        birth = "/home/alice\t2020-02-03 04:05:06.123456789 +0800\n/srv/bob\t-\n"
        with patch.object(probe, "auth_files", return_value=[]), \
             patch.object(probe, "command_output", side_effect=["", birth]) as run:
            result = probe.collect(PASSWD)
        self.assertEqual(result, {"alice": {"created_at": "2020-02-03T04:05:06.123456789+08:00", "source": "home_birth"}})
        self.assertEqual(run.call_args.args[0], ["stat", "-c", "%n\t%w", "--", "/home/alice", "/srv/bob"])

    def test_missing_tools_timeouts_and_partial_stat_results(self):
        for error in (FileNotFoundError(), PermissionError(), subprocess.TimeoutExpired("journalctl", 20)):
            with self.subTest(error=error), patch.object(probe.subprocess, "run", side_effect=error):
                self.assertEqual(probe.command_output(["journalctl"]), "")
        with patch.object(probe.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "/home/alice\t-\n")):
            self.assertEqual(probe.command_output(["stat"]), "/home/alice\t-\n")
        with patch.object(probe, "auth_files", return_value=[]), patch.object(probe, "command_output", return_value=""):
            self.assertEqual(probe.collect(PASSWD), {})

    def test_compressed_rotation_order(self):
        paths = ["/var/log/auth.log", "/var/log/auth.log.1", "/var/log/auth.log.2.gz", "/var/log/auth.log.10.gz"]
        with patch.object(probe.glob, "glob", return_value=paths):
            self.assertEqual(probe.auth_files(), [paths[3], paths[2], paths[1], paths[0]])

    def test_latest_creation_invalid_timestamps_and_home_mismatch(self):
        accounts = {"alice": {"uid": 1001, "home": "/home/alice"}}
        output = "\n".join([
            log("alice", 1001, "/home/alice", "2020-01-01T00:00:00Z"),
            log("alice", 1001, "/home/alice", "2025-01-01T00:00:00Z"),
            log("alice", 1001, "/home/other", "2026-01-01T00:00:00Z"),
            log("alice", 1001, "/home/alice", "2026-99-99T00:00:00Z"),
            log("alice", 1001, "/home/alice", "Aug 99 00:00:00"),
        ])
        self.assertEqual(probe.parse_logs(output, accounts), {"alice": "2025-01-01T00:00:00Z"})

    def test_filters_same_accounts_as_existing_scan(self):
        passwd = PASSWD + "root:x:0:0::/root:/bin/bash\nsrvmgr:x:999:999::/home/srvmgr:/bin/bash\ndaemon:x:1:1::/:/bin/false\nnobody:x:65534:65534::/nonexistent:/bin/false\n"
        with patch.object(probe, "auth_files", return_value=[]), patch.object(probe, "command_output", return_value="") as run:
            probe.collect(passwd)
        self.assertEqual(run.call_args.args[0][4:], ["/home/alice", "/srv/bob", "/root", "/home/srvmgr", "/", "/nonexistent"])
