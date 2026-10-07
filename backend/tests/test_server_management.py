from __future__ import annotations

import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class ServerManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {
            'SRVMGR_DATA_DIR': self.temp.name,
            'SRVMGR_DB_PATH': str(Path(self.temp.name) / 'management.db'),
            'SRVMGR_ADMIN_PASSWORD': 'correct-horse-battery-staple',
            'SRVMGR_DESKTOP_TOKEN': '',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        from app import config, db, main, ansible_service
        for module in (config, db, ansible_service, main):
            importlib.reload(module)
        self.main, self.db, self.service = main, db, ansible_service
        main.init_db()
        from fastapi.testclient import TestClient
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        login = self.client.post('/api/login', json={'username': 'admin', 'password': 'correct-horse-battery-staple'})
        self.headers = {'X-CSRF-Token': login.json()['csrf']}
        self.body = {'name': 'test-host', 'hostname': '2001:db8::1', 'port': 2222, 'ssh_user': 'operator', 'key_path': '~/.ssh/test key'}

    def add_server(self):
        response = self.client.post('/api/servers', json=self.body, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['id']

    def test_crud_clears_stale_accounts_and_survives_restart(self):
        server_id = self.add_server()
        self.db.execute('INSERT INTO server_users(server_id,username,uid,gid,home,shell,is_sudo,is_disabled,scanned_at) VALUES(?,?,?,?,?,?,?,?,?)', (server_id, 'alice', 1001, 1001, '/home/alice', '/bin/bash', 0, 0, self.db.now()))
        response = self.client.put(f'/api/servers/{server_id}', headers=self.headers, json={**self.body, 'hostname': 'new.example.com', 'name': 'new-name', 'enabled': False})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.db.rows('SELECT * FROM server_users WHERE server_id=?', (server_id,)))
        self.assertEqual(self.db.row('SELECT last_scan_status FROM servers WHERE id=?', (server_id,))['last_scan_status'], 'never')
        self.assertEqual(self.client.post(f'/api/servers/{server_id}/scan', headers=self.headers).status_code, 400)
        self.assertEqual(self.client.delete(f'/api/servers/{server_id}', headers=self.headers).status_code, 200)
        # Deleting every seed must not cause them to reappear at startup.
        for server in self.db.rows('SELECT id FROM servers'):
            self.assertEqual(self.client.delete(f"/api/servers/{server['id']}", headers=self.headers).status_code, 200)
        self.db.init_db()
        self.assertEqual(self.db.rows('SELECT * FROM servers'), [])
        self.assertEqual(self.client.post('/api/scan', headers=self.headers).status_code, 400)
        self.assertTrue(self.db.row("SELECT 1 FROM audit_log WHERE event='server_removed'"))

    def test_default_key_path_is_expanded_and_saved(self):
        body = {key: value for key, value in self.body.items() if key != 'key_path'}
        response = self.client.post('/api/servers', json=body, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        server_id = response.json()['id']
        server = self.db.row('SELECT * FROM servers WHERE id=?', (server_id,))
        self.assertEqual(server['key_path'], str(Path('~/.ssh/id_rsa').expanduser()))
        self.db.init_db()
        self.assertEqual(self.db.row('SELECT key_path FROM servers WHERE id=?', (server_id,))['key_path'], server['key_path'])

    def test_creation_time_migration_preserves_existing_accounts(self):
        server_id = self.add_server()
        with self.db.connect() as conn:
            conn.execute('DROP TABLE server_users')
            legacy_schema = self.db.SCHEMA.replace('  created_at TEXT,\n  created_at_source TEXT,\n', '')
            conn.executescript(legacy_schema)
            conn.execute(
                'INSERT INTO server_users VALUES(?,?,?,?,?,?,?,?,?)',
                (server_id, 'alice', 1001, 1001, '/home/alice', '/bin/bash', 0, 0, self.db.now()),
            )
        self.db.init_db()
        self.db.init_db()
        user = self.db.row('SELECT * FROM server_users WHERE server_id=?', (server_id,))
        self.assertEqual(user['username'], 'alice')
        self.assertIsNone(user['created_at'])
        self.assertIsNone(user['created_at_source'])

    def test_scan_saves_creation_time_privately_and_retains_it_after_log_rotation(self):
        server_id = self.add_server()
        raw = {'passwd': 'alice:x:1001:1001::/home/alice:/bin/bash\nbob:x:1002:1002::/srv/bob:/bin/bash',
               'creation_times': {'alice': {'created_at': '2025-08-09T10:11:12+08:00', 'source': 'auth_log'}}}

        def scan_output(playbook, limit, extra, timeout):
            self.assertEqual(playbook, 'scan_users.yml')
            Path(extra['scan_output_dir'], f'{limit}.json').write_text(json.dumps(raw))
            return self.service.RunResult(True, '')

        with patch.object(self.service, '_run', side_effect=scan_output):
            response = self.client.post(f'/api/servers/{server_id}/scan', headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()['ok'])
            alice = self.db.row('SELECT * FROM server_users WHERE server_id=? AND username=?', (server_id, 'alice'))
            self.assertEqual(alice['created_at'], '2025-08-09T10:11:12+08:00')
            self.assertEqual(alice['created_at_source'], 'auth_log')
            self.assertIsNone(self.db.row('SELECT created_at FROM server_users WHERE username=?', ('bob',))['created_at'])
            visible = self.client.get('/api/dashboard').json()['users']
            self.assertTrue(visible)
            for user in visible:
                self.assertNotIn('created_at', user)
                self.assertNotIn('created_at_source', user)
            self.assertNotIn('2025-08-09T10:11:12', response.text)

            raw['creation_times'] = {'alice': {'created_at': '2020-01-01T00:00:00Z', 'source': 'home_birth'}}
            self.service.scan_servers(['test-host'])
            self.assertEqual(self.db.row('SELECT created_at FROM server_users WHERE username=?', ('alice',))['created_at'], alice['created_at'])
            raw['creation_times'] = {}
            self.service.scan_servers(['test-host'])
            self.assertEqual(self.db.row('SELECT created_at FROM server_users WHERE username=?', ('alice',))['created_at'], alice['created_at'])

            # A changed account identity must not inherit its predecessor's date.
            raw['passwd'] = raw['passwd'].replace('alice:x:1001:1001', 'alice:x:2001:2001')
            self.service.scan_servers(['test-host'])
            self.assertIsNone(self.db.row('SELECT created_at FROM server_users WHERE username=?', ('alice',))['created_at'])

    def test_rescan_upgrades_home_birth_to_log_timestamp(self):
        self.add_server()
        raw = {'passwd': 'alice:x:1001:1001::/home/alice:/bin/bash',
               'creation_times': {'alice': {'created_at': '2024-01-01T00:00:00Z', 'source': 'home_birth'}}}

        def scan_output(playbook, limit, extra, timeout):
            Path(extra['scan_output_dir'], f'{limit}.json').write_text(json.dumps(raw))
            return self.service.RunResult(True, '')

        with patch.object(self.service, '_run', side_effect=scan_output):
            self.service.scan_servers(['test-host'])
            self.assertEqual(self.db.row('SELECT created_at_source FROM server_users WHERE username=?', ('alice',))['created_at_source'], 'home_birth')
            raw['creation_times']['alice'] = {'created_at': '2025-08-09T10:11:12Z', 'source': 'journal'}
            self.service.scan_servers(['test-host'])
        user = self.db.row('SELECT * FROM server_users WHERE username=?', ('alice',))
        self.assertEqual(user['created_at'], '2025-08-09T10:11:12Z')
        self.assertEqual(user['created_at_source'], 'journal')

    def test_dashboard_exposes_aggregated_history_with_all_account_types(self):
        self.add_server()
        raw = {'passwd': 'root:x:0:0::/root:/bin/bash\nsrvmgr:x:999:999::/home/srvmgr:/bin/bash\noperator:x:998:998::/home/operator:/bin/bash\nalice:x:1001:1001::/home/alice:/bin/bash',
               'creation_times': {'root': {'created_at': '2020-01-01T00:00:00Z', 'source': 'home_birth'},
                                  'alice': {'created_at': '2025-08-09T10:11:12Z', 'source': 'auth_log'}}}

        def scan_output(playbook, limit, extra, timeout):
            for name in limit.split(','):
                Path(extra['scan_output_dir'], f'{name}.json').write_text(json.dumps(raw))
            return self.service.RunResult(True, '')

        with patch.object(self.service, '_run', side_effect=scan_output):
            self.service.scan_servers(['test-host', 'gpu1'])
        response = self.client.get('/api/dashboard')
        self.assertEqual(response.status_code, 200)
        dashboard = response.json()
        self.assertEqual(len(dashboard['users']), 8)
        self.assertEqual(dashboard['statistics']['total_unique_users'], 4)
        self.assertEqual(dashboard['statistics']['dated_users'], 2)
        self.assertEqual(dashboard['statistics']['undated_users'], 2)
        self.assertEqual(dashboard['statistics']['history'][-1]['total'], 2)
        self.assertEqual(self.client.delete(f"/api/servers/{self.db.row('SELECT id FROM servers WHERE name=?', ('test-host',))['id']}", headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get('/api/dashboard').json()['statistics'], dashboard['statistics'])

    def test_server_validation_and_csrf(self):
        self.assertEqual(self.client.post('/api/servers', json=self.body).status_code, 403)
        server_id = self.add_server()
        self.assertEqual(self.client.put(f'/api/servers/{server_id}', json=self.body).status_code, 403)
        self.assertEqual(self.client.delete(f'/api/servers/{server_id}').status_code, 403)
        for action in ('test', 'scan', 'status'):
            self.assertEqual(self.client.post(f'/api/servers/{server_id}/{action}').status_code, 403)
        self.assertEqual(self.client.post('/api/servers', json=self.body, headers=self.headers).status_code, 409)
        for fields in ({'name': 'all'}, {'name': 'x,all'}, {'hostname': '-oProxyCommand=x'}, {'hostname': 'https://server:22'}, {'ssh_user': 'root x=y'}, {'port': 0}, {'port': 65536}, {'key_path': 'relative'}):
            with self.subTest(fields=fields):
                self.assertEqual(self.client.post('/api/servers', json={**self.body, **fields}, headers=self.headers).status_code, 422)

    def test_pending_requests_prevent_retargeting(self):
        server_id = self.add_server()
        response = self.client.post('/api/actions/user', json={'username': 'alice', 'servers': ['test-host'], 'action': 'delete_user'}, headers=self.headers)
        action_id = response.json()['action_id']
        self.assertEqual(self.db.row('SELECT status FROM actions WHERE id=?', (action_id,))['status'], 'pending')
        self.assertEqual(self.client.put(f'/api/servers/{server_id}', json={**self.body, 'hostname': 'other.example.com'}, headers=self.headers).status_code, 409)
        self.assertEqual(self.client.delete(f'/api/servers/{server_id}', headers=self.headers).status_code, 409)
        self.assertEqual(self.client.post(f'/api/actions/{action_id}/reject', headers=self.headers).status_code, 200)
        self.assertEqual(self.client.delete(f'/api/servers/{server_id}', headers=self.headers).status_code, 200)
        self.assertEqual(self.db.row('SELECT status FROM actions WHERE id=?', (action_id,))['status'], 'rejected')

    def test_protected_accounts_and_legacy_approval(self):
        server_id = self.add_server()
        self.db.execute('INSERT INTO server_users(server_id,username,uid,gid,home,shell,is_sudo,is_disabled,scanned_at) VALUES(?,?,?,?,?,?,?,?,?)', (server_id, 'daemon', 10, 10, '/', '/bin/sh', 0, 0, self.db.now()))
        for username in ('root', 'operator', 'srvmgr', 'daemon'):
            for action in ('delete_user', 'disable_user', 'set_sudo'):
                response = self.client.post('/api/actions/user', json={'username': username, 'servers': ['test-host'], 'action': action, 'sudo': False}, headers=self.headers)
                self.assertEqual(response.status_code, 400)
        action_id = self.db.execute('INSERT INTO actions(action_type,target_server,target_user,payload_json,requested_by,requested_at) VALUES(?,?,?,?,?,?)', ('delete_user', 'test-host', 'root', json.dumps({'servers': ['test-host']}), 1, self.db.now()))
        with patch.object(self.service, 'execute_action') as run:
            self.assertEqual(self.client.post(f'/api/actions/{action_id}/approve', headers=self.headers).status_code, 400)
            run.assert_not_called()

    def test_remote_routes_and_sanitized_errors(self):
        server_id = self.add_server()
        raw = 'UNREACHABLE Permission denied SECRET /Users/private/key traceback'
        with patch.object(self.service, '_run', return_value=self.service.RunResult(False, raw)) as run:
            response = self.client.post(f'/api/servers/{server_id}/test', headers=self.headers)
            self.assertFalse(response.json()['ok'])
            self.assertNotIn('SECRET', response.text)
            run.assert_called_once_with('test_connection.yml', 'test-host', timeout=30)
        with patch.object(self.service, 'scan_servers', return_value=([], {'test-host': raw})) as scan:
            response = self.client.post(f'/api/servers/{server_id}/scan', headers=self.headers)
            scan.assert_called_once_with(['test-host'])
            self.assertNotIn('SECRET', response.text)
        with patch.object(self.service, 'inspect_server', side_effect=RuntimeError(raw)):
            response = self.client.post(f'/api/servers/{server_id}/status', headers=self.headers)
            self.assertEqual(response.status_code, 502)
            self.assertNotIn('SECRET', response.text)
        self.db.execute('UPDATE servers SET last_scan_error=? WHERE id=?', (raw, server_id))
        self.db.execute('INSERT INTO actions(action_type,target_server,target_user,payload_json,status,requested_by,requested_at,error) VALUES(?,?,?,?,?,?,?,?)', ('delete_user', 'test-host', 'alice', '{}', 'failed', 1, self.db.now(), raw))
        self.assertNotIn('SECRET', self.client.get('/api/dashboard').text)
        self.assertIn('SECRET', self.db.row('SELECT last_scan_error FROM servers WHERE id=?', (server_id,))['last_scan_error'])

    def test_delete_dispatch_and_resource_parsing(self):
        server_id = self.add_server()
        response = self.client.post('/api/actions/user', json={'username': 'alice', 'servers': ['test-host'], 'action': 'delete_user'}, headers=self.headers)
        action_id = response.json()['action_id']
        with patch.object(self.service, '_run', return_value=self.service.RunResult(True, 'ok')) as run, patch.object(self.service, 'scan_servers', return_value=([], {})):
            self.assertEqual(self.client.post(f'/api/actions/{action_id}/approve', headers=self.headers).status_code, 200)
            self.assertEqual([call.args[0] for call in run.call_args_list], ['preflight.yml', 'delete_user.yml'])
        self.assertEqual(self.db.row('SELECT status FROM actions WHERE id=?', (action_id,))['status'], 'executed')
        def status_output(playbook, name, extra, timeout):
            Path(extra['status_output_dir'], f'{name}.json').write_text(json.dumps({'uptime': '90061.2 100', 'load': '1.1 0.2 0.3 1/100 1', 'memory': 'MemTotal: 8192000 kB\nMemAvailable: 4096000 kB', 'disk': 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 104857600 52428800 52428800 50% /'}))
            return self.service.RunResult(True, '')
        with patch.object(self.service, '_run', side_effect=status_output):
            response = self.client.post(f'/api/servers/{server_id}/status', headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['memory_used_mb'], 4000)
            self.assertEqual(response.json()['disk_percent'], 50)
        inventory = json.loads(self.service._inventory().read_text())
        host = inventory['all']['children']['managed']['hosts']['test-host']
        self.assertEqual(host['ansible_host'], '2001:db8::1')
        self.assertTrue(host['ansible_ssh_private_key_file'].endswith('test key'))

    def test_operation_lock_prevents_changes_during_execution(self):
        self.main.operation_lock.acquire()
        try:
            self.assertEqual(self.client.post('/api/servers', json=self.body, headers=self.headers).status_code, 409)
        finally:
            self.main.operation_lock.release()
        self.add_server()

    def test_completed_action_reports_refresh_failure(self):
        server_id = self.add_server()
        response = self.client.post('/api/actions/user', json={'username': 'alice', 'servers': ['test-host'], 'action': 'delete_user'}, headers=self.headers)
        action_id = response.json()['action_id']
        with patch.object(self.service, '_run', return_value=self.service.RunResult(True, 'ok')), patch.object(self.service, 'scan_servers', side_effect=RuntimeError('private diagnostic output')):
            response = self.client.post(f'/api/actions/{action_id}/approve', headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['warning'])
        self.assertNotIn('private diagnostic', response.text)
        self.assertEqual(self.db.row('SELECT last_scan_status FROM servers WHERE id=?', (server_id,))['last_scan_status'], 'error')
        self.assertEqual(self.db.row('SELECT status FROM actions WHERE id=?', (action_id,))['status'], 'executed')

    def test_monitoring_auth_errors_and_management_independence(self):
        server_id = self.add_server()
        path = f'/api/servers/{server_id}/metrics'
        self.assertEqual(self.client.post(path).status_code, 403)
        sample = {'checked_at': self.db.now(), 'cpu': {'percent': 25}, 'memory': {}, 'gpu': {}, 'disks': [], 'warnings': []}
        self.main.operation_lock.acquire()
        try:
            with patch.object(self.main.monitoring_service, 'inspect_resources', return_value=sample):
                before = len(self.db.rows('SELECT * FROM audit_log'))
                response = self.client.post(path, headers=self.headers)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json(), sample)
                self.assertEqual(response.headers['cache-control'], 'no-store')
                self.assertEqual(len(self.db.rows('SELECT * FROM audit_log')), before)
        finally:
            self.main.operation_lock.release()
        with patch.object(self.main.monitoring_service, 'inspect_resources', side_effect=RuntimeError('Permission denied SECRET')):
            response = self.client.post(path, headers=self.headers)
            self.assertEqual(response.status_code, 502)
            self.assertNotIn('SECRET', response.text)
        with patch.object(self.main.monitoring_service, 'inspect_resources', side_effect=self.main.monitoring_service.SampleBusy):
            self.assertEqual(self.client.post(path, headers=self.headers).status_code, 409)
        self.db.execute('UPDATE servers SET enabled=0 WHERE id=?', (server_id,))
        with patch.object(self.main.monitoring_service, 'inspect_resources') as collect:
            self.assertEqual(self.client.post(path, headers=self.headers).status_code, 400)
            self.assertEqual(self.client.post('/api/servers/999999/metrics', headers=self.headers).status_code, 404)
            collect.assert_not_called()
        self.client.cookies.clear()
        self.assertEqual(self.client.post(path, headers=self.headers).status_code, 401)
