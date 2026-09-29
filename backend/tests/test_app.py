from __future__ import annotations

import importlib
import os
import re
import tempfile
import unittest
import zipfile
from pathlib import Path


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        os.environ["SRVMGR_DATA_DIR"] = cls.temp.name
        os.environ["SRVMGR_DB_PATH"] = str(Path(cls.temp.name) / "test.db")
        os.environ["SRVMGR_ADMIN_PASSWORD"] = "correct-horse-battery-staple"
        import app.config
        import app.db
        import app.main
        importlib.reload(app.config)
        importlib.reload(app.db)
        importlib.reload(app.main)
        app.main.init_db()
        from fastapi.testclient import TestClient
        cls.client = TestClient(app.main.app)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def login(self):
        response = self.client.post("/api/login", json={"username":"admin","password":"correct-horse-battery-staple"})
        self.assertEqual(response.status_code, 200)
        return response.json()["csrf"]

    def test_login_and_dashboard(self):
        csrf = self.login()
        response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        servers = {item["name"]: item for item in response.json()["servers"]}
        self.assertEqual(len(servers), 5)
        self.assertEqual(servers["gpu1"]["hostname"], "server.luo-group.com")
        self.assertEqual(servers["gpu1"]["port"], 10901)
        self.assertEqual(Path(servers["gpu1"]["key_path"]).name, "id_rsa")
        self.assertEqual(set(servers["gpu1"]), {"id", "name", "hostname", "port", "ssh_user", "key_path", "enabled", "last_scan_at", "last_scan_status", "last_scan_error"})
        self.assertTrue(csrf)

    def test_write_requires_csrf(self):
        self.login()
        response = self.client.post("/api/actions/create-user", json={"username":"alice","servers":["gpu1"]})
        self.assertEqual(response.status_code, 403)

    def test_create_is_pending(self):
        csrf = self.login()
        response = self.client.post(
            "/api/actions/create-user", headers={"X-CSRF-Token":csrf},
            json={"username":"alice","servers":["gpu1","cpu1"],"sudo":False},
        )
        self.assertEqual(response.status_code, 200)
        dashboard = self.client.get("/api/dashboard").json()
        action = next(a for a in dashboard["actions"] if a["id"] == response.json()["action_id"])
        self.assertEqual(action["status"], "pending")
        self.assertFalse(action["private_key_ready"])

    def test_initial_password_and_login_archive(self):
        from app import ansible_service

        password = ansible_service._generate_initial_password()
        self.assertEqual(len(password), 16)
        self.assertRegex(password, r"^[A-Za-z0-9]{16}$")
        self.assertTrue(re.search(r"[A-Za-z]", password))
        self.assertTrue(re.search(r"[0-9]", password))
        self.assertTrue(ansible_service._password_hash(password).startswith("$6$"))

        private_path = Path(self.temp.name) / "test-private-key"
        private_path.write_text("PRIVATE KEY CONTENT", encoding="utf-8")
        archive_path = ansible_service._build_credentials_archive(
            9999, "alice", password, ["gpu3", "cpu1"], private_path,
        )
        self.addCleanup(archive_path.unlink, missing_ok=True)
        self.addCleanup(private_path.unlink, missing_ok=True)
        self.assertEqual(archive_path.stat().st_mode & 0o777, 0o600)
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(set(archive.namelist()), {"alice-server-ed25519", "login-instructions.txt"})
            self.assertEqual(archive.read("alice-server-ed25519"), b"PRIVATE KEY CONTENT")
            instructions = archive.read("login-instructions.txt").decode("utf-8")
        self.assertIn(f"Username: alice\n\nPassword: {password}", instructions)
        self.assertIn(
            "ssh alice@server.luo-group.com -p 12901 -i alice-server-ed25519",
            instructions,
        )
        self.assertIn(
            "ssh alice@server.luo-group.com -p 20901 -i alice-server-ed25519",
            instructions,
        )
        self.assertIn("currently supports key-based sign-in only", instructions)

    def test_credentials_archive_is_downloaded_once(self):
        self.login()
        from app.main import execute, now

        archive_path = Path(self.temp.name) / "one-time-login.zip"
        archive_path.write_bytes(b"ZIP-CONTENT")
        action_id = execute(
            """INSERT INTO actions(action_type,target_server,target_user,payload_json,status,requested_by,
            requested_at,executed_at,private_key_path) VALUES(?,?,?,?,?,?,?,?,?)""",
            ("create_user", "gpu3", "download-user", "{}", "executed", 1, now(), now(), str(archive_path)),
        )
        response = self.client.get(f"/api/actions/{action_id}/private-key")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"ZIP-CONTENT")
        self.assertEqual(response.headers["content-type"], "application/zip")
        self.assertIn("download-user-server-login.zip", response.headers["content-disposition"])
        self.assertFalse(archive_path.exists())
        self.assertEqual(self.client.get(f"/api/actions/{action_id}/private-key").status_code, 410)

    def test_invalid_username_rejected(self):
        csrf = self.login()
        response = self.client.post(
            "/api/actions/create-user", headers={"X-CSRF-Token":csrf},
            json={"username":"Bad;Name","servers":["gpu1"]},
        )
        self.assertEqual(response.status_code, 422)

    def test_disable_enable_and_sudo_requests_are_pending(self):
        csrf = self.login()
        for body in (
            {"username":"alice","servers":["gpu1"],"action":"disable_user"},
            {"username":"alice","servers":["gpu1"],"action":"enable_user"},
            {"username":"alice","servers":["gpu1"],"action":"set_sudo","sudo":True},
            {"username":"alice","servers":["gpu1"],"action":"set_sudo","sudo":False},
        ):
            response = self.client.post("/api/actions/user", headers={"X-CSRF-Token":csrf}, json=body)
            self.assertEqual(response.status_code, 200)
            action_id = response.json()["action_id"]
            dashboard = self.client.get("/api/dashboard").json()
            action = next(item for item in dashboard["actions"] if item["id"] == action_id)
            self.assertEqual(action["status"], "pending")


    def test_update_grouped_user_profile(self):
        csrf = self.login()
        from app.main import execute, now, row

        for server in ("gpu1", "gpu2"):
            execute(
                """INSERT INTO server_users(server_id,username,uid,gid,home,shell,is_sudo,is_disabled,scanned_at)
                SELECT id,?,?,?,?,?,?,?,? FROM servers WHERE name=?""",
                ("profile-user", 1200, 1200, "/home/profile-user", "/bin/bash", 0, 0, now(), server),
            )

        path = "/api/users/profile-user/profile"
        response = self.client.put(path, json={"full_name":"张三"})
        self.assertEqual(response.status_code, 403)

        response = self.client.put(
            path, headers={"X-CSRF-Token":csrf}, json={"full_name":"  张三 · 博士生  "},
        )
        self.assertEqual(response.status_code, 200)

        dashboard = self.client.get("/api/dashboard").json()
        accounts = [item for item in dashboard["users"] if item["username"] == "profile-user"]
        self.assertEqual(len(accounts), 2)
        self.assertTrue(all(item["full_name"] == "张三 · 博士生" for item in accounts))

        audit_event = row("SELECT * FROM audit_log WHERE event='user_profile_updated' AND target=?", ("profile-user",))
        self.assertIsNotNone(audit_event)

        response = self.client.put(
            path, headers={"X-CSRF-Token":csrf}, json={"full_name":""},
        )
        self.assertEqual(response.status_code, 200)
        accounts = [item for item in self.client.get("/api/dashboard").json()["users"] if item["username"] == "profile-user"]
        self.assertTrue(all(item["full_name"] == "" for item in accounts))

        response = self.client.put(path, headers={"X-CSRF-Token":csrf}, json={"full_name":"x" * 101})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
