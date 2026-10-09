from __future__ import annotations

import importlib
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class DesktopModeTests(unittest.TestCase):
    def test_opens_dashboard_without_password_but_rejects_other_clients(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {
                "MOSSENTRY_DATA_DIR": directory,
                "MOSSENTRY_DB_PATH": str(Path(directory) / "desktop.db"),
                "MOSSENTRY_DESKTOP_TOKEN": "desktop-test-secret",
            }):
                import app.config
                import app.db
                import app.main

                importlib.reload(app.config)
                importlib.reload(app.db)
                importlib.reload(app.main)
                (Path(directory) / "initial_admin_password").write_text("old-password\n")
                app.main.init_db()

                from fastapi.testclient import TestClient

                with TestClient(app.main.app) as client:
                    self.assertEqual(client.get("/").status_code, 403)
                    self.assertEqual(client.get("/api/dashboard").status_code, 403)
                    client.headers["X-Desktop-Token"] = "desktop-test-secret"
                    page = client.get("/")
                    self.assertEqual(page.status_code, 200)
                    self.assertIn('<div id="root"></div>', page.text)
                    self.assertIn('/assets/', page.text)
                    self.assertIn('<title>Mossentry</title>', page.text)
                    favicon = re.search(r'href="(/assets/[^\"]+\.svg)"', page.text)
                    self.assertIsNotNone(favicon)
                    icon = client.get(favicon.group(1))
                    self.assertEqual(icon.status_code, 200)
                    self.assertIn('Mossentry', icon.text)
                    asset = re.search(r'src="(/assets/[^"]+\.js)"', page.text)
                    self.assertIsNotNone(asset)
                    self.assertEqual(client.get(asset.group(1)).status_code, 200)
                    self.assertFalse((Path(directory) / "initial_admin_password").exists())

                    dashboard = client.get("/api/dashboard")
                    self.assertEqual(dashboard.status_code, 200)
                    self.assertTrue(dashboard.json()["admin"]["desktop_mode"])
                    csrf = dashboard.json()["admin"]["csrf"]
                    payload = {"username": "alice", "servers": ["gpu1"], "sudo": False}
                    self.assertEqual(client.post("/api/actions/create-user", json=payload).status_code, 403)
                    self.assertEqual(client.post(
                        "/api/actions/create-user", json=payload,
                        headers={"X-CSRF-Token": csrf},
                    ).status_code, 200)
                    self.assertEqual(client.post("/api/login", json={
                        "username": "admin", "password": "anything",
                    }).status_code, 404)

        os.environ.pop("SRVMGR_DESKTOP_TOKEN", None)
        importlib.reload(app.config)
        importlib.reload(app.db)
        importlib.reload(app.main)
