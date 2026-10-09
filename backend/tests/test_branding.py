from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class BrandingConfigTests(unittest.TestCase):
    def config(self, **settings):
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('MOSSENTRY_', 'SRVMGR_'))}
        env.update(settings)
        result = subprocess.check_output([
            sys.executable, '-c',
            'import json; from app.config import DATA_DIR, DB_PATH, setting; '
            'print(json.dumps([str(DATA_DIR), str(DB_PATH), setting("DESKTOP_TOKEN", "")]))',
        ], cwd=Path(__file__).resolve().parents[1], env=env, text=True)
        return json.loads(result)

    def test_new_installation_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            data, database, token = self.config(
                MOSSENTRY_DATA_DIR=directory, SRVMGR_DATA_DIR='/unused/legacy',
                MOSSENTRY_DESKTOP_TOKEN='new-token', SRVMGR_DESKTOP_TOKEN='old-token',
            )
            self.assertEqual(data, str(Path(directory).resolve()))
            self.assertEqual(database, str(Path(directory).resolve() / 'mossentry.db'))
            self.assertEqual(token, 'new-token')

    def test_existing_database_and_legacy_settings_still_work(self):
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory).resolve() / 'server_manager.db'
            old.touch()
            self.assertEqual(self.config(SRVMGR_DATA_DIR=directory)[1], str(old))
            self.assertEqual(self.config(MOSSENTRY_DATA_DIR=directory)[1], str(old))
            current = old.with_name('mossentry.db')
            current.touch()
            self.assertEqual(self.config(MOSSENTRY_DATA_DIR=directory)[1], str(current))
            self.assertEqual(self.config(MOSSENTRY_DATA_DIR=directory,
                                         SRVMGR_DB_PATH=str(old))[1], str(old))
