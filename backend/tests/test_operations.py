"""Agentless operations regressions; no configured servers are contacted."""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Event
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app import operations_probe as probe


class ProbeTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == 'win32', 'Probe executes on Linux hosts only')
    def test_capture_drains_both_pipes_and_bounds_output(self):
        text, warning = probe.command([sys.executable, '-c', "import sys; sys.stdout.write('row\\n' * 600000); sys.stderr.write('warning' * 10000)"])
        self.assertLessEqual(len(text), 2 * 1024 * 1024)
        self.assertLess(len(warning), 4200)
        self.assertIn('truncated', warning)
        with self.assertRaises(subprocess.TimeoutExpired):
            probe.command([sys.executable, '-c', 'import time; time.sleep(2)'], timeout=.05)

    def test_no_systemd_is_explicitly_unavailable(self):
        with patch.object(probe, 'has_systemd', return_value=False):
            self.assertEqual(probe.services()['available'], False)
        with patch.object(probe.shutil, 'which', return_value=None):
            self.assertEqual(probe.logs({})['available'], False)

    def test_service_list_includes_inactive_and_failed_units(self):
        with patch.object(probe, 'has_systemd', return_value=True), patch.object(probe, 'command', side_effect=[
            ('nginx.service enabled enabled\nsshd.service enabled\nsleep.service disabled\n', ''),
            ('nginx.service loaded failed failed Web server\nsshd.service loaded active running SSH daemon\n', ''),
        ]):
            result = probe.services()['services']
        self.assertEqual(result[0]['unit'], 'nginx.service')
        self.assertEqual(next(s for s in result if s['unit'] == 'sleep.service')['active'], 'inactive')
        self.assertTrue(next(s for s in result if s['unit'] == 'sshd.service')['protected'])

    def test_protected_alias_and_missing_units_never_mutate(self):
        for properties in ('Id=ssh.service\nNames=custom.service ssh.service\nLoadState=loaded',
                           'Id=custom.service\nNames=custom.service\nLoadState=not-found',
                           'Id=custom.service\nLoadState=loaded\nRefuseManualStop=yes'):
            with patch.object(probe, 'has_systemd', return_value=True), patch.object(probe.os, 'geteuid', return_value=0), patch.object(probe, 'command', return_value=(properties, '')) as command:
                with self.assertRaises(ValueError):
                    probe.service_change({'operation': 'restart', 'unit': 'custom.service'})
                self.assertEqual(command.call_count, 1)
        for unit in ('ssh.service', 'SSHD.service', 'sshd@connection.service', 'NetworkManager.service'):
            with patch.object(probe, 'command') as command:
                with self.assertRaises(ValueError):
                    probe.service_change({'operation': 'stop', 'unit': unit})
                command.assert_not_called()

    def test_fixed_argv_no_shell_and_boot_policy_without_now(self):
        with patch.object(probe, 'has_systemd', return_value=True), patch.object(probe.os, 'geteuid', return_value=0), patch.object(probe, 'command', side_effect=[
            ('Id=nginx.service\nNames=nginx.service\nLoadState=loaded', ''), ('', ''), ('ActiveState=inactive\nUnitFileState=enabled', ''),
        ]) as command:
            value = probe.service_change({'operation': 'enable', 'unit': 'nginx.service'})
            self.assertEqual(command.call_args_list[1].args[0], ['systemctl', 'enable', '--', 'nginx.service'])
            self.assertEqual(value['state']['UnitFileState'], 'enabled')

    def test_payload_rejected_before_execution(self):
        with patch.object(probe.sys, 'platform', 'linux'), patch.object(probe, 'command') as command:
            for unit in ('--help.service', 'a;touch /tmp/x.service', '*.service', '../a.service', 'a\n.service'):
                with self.assertRaises(ValueError):
                    probe.run({'operation': 'stop', 'unit': unit})
            with self.assertRaises(ValueError):
                probe.run({'operation': 'shell', 'unit': ''})
            command.assert_not_called()

    def test_journal_bounds_and_binary_messages(self):
        entry = {'MESSAGE': [104, 105], '__REALTIME_TIMESTAMP': '1234', 'PRIORITY': '3'}
        with patch.object(probe.shutil, 'which', return_value='/usr/bin/journalctl'), patch.object(probe.os, 'geteuid', return_value=1000), patch.object(probe, 'command', return_value=(json.dumps(entry), 'Limited access')) as command:
            data = probe.logs({'minutes': 30, 'lines': 5, 'priority': 3, 'unit': 'nginx.service'})
            self.assertEqual(data['entries'][0]['message'], 'hi')
            self.assertEqual(data['scope'], 'accessible')
            argv = command.call_args.args[0]
            self.assertIn('-30min', argv)
            self.assertEqual(argv[-2:], ['--unit', 'nginx.service'])
            self.assertTrue(data['warnings'])
            with self.assertRaises(ValueError):
                probe.logs({'lines': 1001})

    def test_inspection_thresholds_deduplicate_mounts_and_mark_unknown(self):
        def read(path):
            return {'/etc/os-release': 'PRETTY_NAME="Test Linux"', '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 50 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB',
                    '/proc/self/mounts': '/dev/sda1 / ext4 rw 0 0\n/dev/sda1 /bind ext4 rw 0 0\nhost:/data /net nfs rw 0 0', '/proc/uptime': '100.2 50'}[str(path)]
        stat = SimpleNamespace(f_blocks=100, f_bfree=5, f_bavail=4, f_files=1000, f_ffree=20, f_frsize=4096)
        with patch.object(probe.Path, 'read_text', read), patch.object(probe.os, 'stat', return_value=SimpleNamespace(st_dev=1)), patch.object(probe.os, 'statvfs', return_value=stat), patch.object(probe.os, 'getloadavg', return_value=(3, 4, 5), create=True), patch.object(probe.os, 'cpu_count', return_value=2), patch.object(probe, 'has_systemd', return_value=False):
            result = probe.inspect()
        self.assertEqual(result['os'], 'Test Linux')
        self.assertEqual(len(result['filesystems']), 1)
        self.assertIsNone(result['failed_services'])
        self.assertIsNone(result['swap_percent'])
        self.assertEqual({a['kind'] for a in result['alerts']}, {'memory', 'load', 'disk', 'inode'})


class OperationAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {'MOSSENTRY_DATA_DIR': self.temp.name, 'MOSSENTRY_DB_PATH': str(Path(self.temp.name) / 'operations.db'),
                                      'MOSSENTRY_ADMIN_PASSWORD': 'test-admin-password', 'MOSSENTRY_DESKTOP_TOKEN': ''})
        env.start(); self.addCleanup(env.stop)
        from app import config, db, main, ansible_service, operations_service
        for module in (config, db, ansible_service, main):
            importlib.reload(module)
        self.main, self.db, self.service = main, db, operations_service
        db.init_db()
        from fastapi.testclient import TestClient
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        login = self.client.post('/api/login', json={'username': 'admin', 'password': 'test-admin-password'})
        self.headers = {'X-CSRF-Token': login.json()['csrf']}

    def post(self, path, body):
        return self.client.post(path, json=body, headers=self.headers)

    def await_job(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = self.client.get(f'/api/operations/{job_id}').json()
            if result['status'] != 'running' and not self.main.operation_lock.locked():
                return result
            time.sleep(.01)
        self.fail('Worker did not finish')

    def test_import_preview_atomic_conflicts_credentials_and_paused_defaults(self):
        entry = {'name': 'new-host', 'hostname': 'host.test', 'ssh_user': 'operator', 'group_name': 'lab', 'notes': 'GPU lab'}
        preview = self.post('/api/inventory/import', {'servers': [entry]})
        self.assertEqual(preview.status_code, 200)
        self.assertIsNone(self.db.row("SELECT * FROM servers WHERE name='new-host'"))
        response = self.post('/api/inventory/import', {'servers': [entry], 'preview': False})
        self.assertEqual(response.status_code, 200)
        server = self.db.row("SELECT * FROM servers WHERE name='new-host'")
        self.assertEqual((server['group_name'], server['notes'], server['enabled']), ('lab', 'GPU lab', 0))
        response = self.post('/api/inventory/import', {'servers': [entry, {**entry, 'name': 'other'}], 'preview': False})
        self.assertEqual(response.status_code, 409)
        self.assertIsNone(self.db.row("SELECT * FROM servers WHERE name='other'"))
        self.assertEqual(self.post('/api/inventory/import', {'servers': [{**entry, 'sudo_password': 'secret'}]}).status_code, 400)
        self.assertEqual(self.post('/api/inventory/import', {'servers': [{**entry, 'password': 'secret'}]}).status_code, 422)
        self.db.execute('INSERT INTO server_credentials(server_id,sudo_password) VALUES(?,?)', (server['id'], 'secret-value'))
        exported = self.client.get('/api/inventory/export')
        self.assertNotIn('secret-value', exported.text)
        self.assertNotIn('sudo_password', exported.text)
        self.assertEqual(exported.headers['cache-control'], 'no-store')
        self.db.init_db()
        self.assertEqual(self.db.row('SELECT notes FROM servers WHERE id=?', (server['id'],))['notes'], 'GPU lab')

    def test_authorization_validation_and_protection(self):
        body = {'operation': 'inspect', 'servers': ['gpu1']}
        self.assertEqual(self.client.post('/api/operations', json=body).status_code, 403)
        for change in ({'servers': ['missing']}, {'operation': 'shell'}, {'servers': []}, {'operation': 'logs', 'lines': 1001},
                       {'operation': 'stop', 'unit': 'nginx.service'}, {'operation': 'stop', 'unit': 'ssh.service', 'confirmation': 'stop ssh.service'},
                       {'operation': 'restart', 'unit': 'a;whoami.service'}):
            response = self.post('/api/operations', {**body, **change})
            self.assertIn(response.status_code, (400, 422), response.text)
        self.db.execute("UPDATE servers SET enabled=0 WHERE name='gpu1'")
        self.assertEqual(self.post('/api/operations', body).status_code, 400)
        self.assertFalse(self.main.operation_lock.locked())
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/operations').status_code, 401)
        self.assertEqual(self.client.get('/api/inventory/export').status_code, 401)

    def test_per_host_partial_results_history_and_delete(self):
        with patch.object(self.service, 'run_remote', side_effect=[RuntimeError('timed out SECRET'), {'checked_at': self.db.now(), 'os': 'Linux'}]) as remote:
            created = self.post('/api/operations', {'operation': 'inspect', 'servers': ['gpu1', 'cpu1', 'gpu1']})
            self.assertEqual(created.status_code, 202, created.text)
            job = self.await_job(created.json()['id'])
        self.assertEqual(remote.call_count, 2)
        self.assertEqual(job['status'], 'partial')
        self.assertEqual({r['status'] for r in job['results']}, {'failed', 'completed'})
        self.assertNotIn('SECRET', json.dumps(job))
        self.assertEqual(self.client.get('/api/operations').json()['total'], 1)
        response = self.client.delete(f"/api/operations/{job['id']}", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get(f"/api/operations/{job['id']}").status_code, 404)
        self.assertTrue(self.db.rows("SELECT * FROM audit_log WHERE event='operation_deleted'"))

    def test_worker_serializes_configuration_and_other_operations(self):
        entered, release = Event(), Event()
        def remote(*args):
            entered.set(); release.wait(3)
            return {'checked_at': self.db.now()}
        with patch.object(self.service, 'run_remote', side_effect=remote):
            created = self.post('/api/operations', {'operation': 'restart', 'unit': 'nginx.service', 'confirmation': 'restart nginx.service', 'servers': ['gpu1']})
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.post('/api/operations', {'operation': 'inspect', 'servers': ['cpu1']}).status_code, 409)
                self.assertEqual(self.client.delete('/api/servers/1', headers=self.headers).status_code, 409)
            finally:
                release.set()
                self.await_job(created.json()['id'])

    def test_recovery_marks_uncertain_jobs_without_retry(self):
        job_id = self.db.execute("INSERT INTO operation_jobs(operation,payload_json,status,created_at) VALUES('restart','{}','running',?)", (self.db.now(),))
        self.db.execute("INSERT INTO operation_results(job_id,server_name,status) VALUES(?,'gpu1','running')", (job_id,))
        with patch.object(self.service, 'run_remote') as remote:
            self.service.recover_interrupted()
            self.service.recover_interrupted()
            remote.assert_not_called()
        job = self.service.job_detail(job_id)
        self.assertEqual(job['status'], 'interrupted')
        self.assertIn('Check the server', job['results'][0]['error'])

    def test_both_transports_use_same_fixed_probe_and_clean_local_results(self):
        from app import ansible_service, native_ssh
        from app.models import OperationRequest
        self.assertEqual(OperationRequest(servers=['gpu1'], operation='logs').lines, 100)
        sample = {'checked_at': self.db.now(), 'available': True, 'entries': []}
        with patch.dict(os.environ, {'MOSSENTRY_SSH_ENGINE': 'native'}), patch.object(native_ssh, 'execute', return_value=json.dumps(sample)) as execute:
            result = self.service.run_remote('gpu1', {'operation': 'logs', 'elevated': False})
            self.assertEqual(result, sample)
            self.assertFalse(execute.call_args.kwargs['sudo'])
            self.assertIn('def service_change', execute.call_args.args[1])
        with patch.dict(os.environ, {'MOSSENTRY_SSH_ENGINE': 'ansible'}), patch.object(ansible_service.sys, 'platform', 'linux'), patch.object(ansible_service, '_ansible_playbook', return_value='ansible-playbook'), patch.object(ansible_service, '_become_password', side_effect=AssertionError('Read only needs no sudo')):
            def run(command, **kwargs):
                extra = json.loads(Path(command[command.index('--extra-vars') + 1][1:]).read_text())
                self.assertFalse(extra['operation_become'])
                (Path(extra['operation_output_dir']) / 'gpu1.json').write_text(json.dumps(sample))
                return subprocess.CompletedProcess(command, 0, '', '')
            with patch.object(ansible_service.subprocess, 'run', side_effect=run):
                self.assertEqual(self.service.run_remote('gpu1', {'operation': 'logs'}), sample)
        self.assertEqual(list((Path(self.temp.name) / 'jobs').glob('operation-*')), [])
