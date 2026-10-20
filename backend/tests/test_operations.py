"""Agentless operations regressions; no configured servers are contacted."""
import importlib
import json
import os
import shlex
import shutil
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


@unittest.skipUnless(shutil.which('bash') and os.name == 'posix', 'Requires local Bash for syntax-only fixtures')
class CommandProbeTests(unittest.TestCase):
    def test_dry_run_never_executes_script_expansions_or_startup_files(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'unexpected'
            startup = Path(directory) / 'startup.sh'
            startup.write_text(f'touch {shlex.quote(str(marker))}\n')
            script = f'echo "$(touch {shlex.quote(str(marker))})"\ntouch {shlex.quote(str(marker))}\n'
            with patch.dict(os.environ, {'BASH_ENV': str(startup), 'ENV': str(startup)}):
                value = probe.shell_operation({'operation': 'dry_run', 'command': script})
            self.assertTrue(value['syntax_ok'])
            self.assertEqual(value['stdout'], '')
            self.assertFalse(marker.exists())

    def test_invalid_multiline_script_never_executes_valid_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'unexpected'
            value = probe.shell_operation({'operation': 'command', 'command': f'touch {shlex.quote(str(marker))}\nif true; then\n'})
            self.assertFalse(value['syntax_ok'])
            self.assertNotEqual(value['exit_code'], 0)
            self.assertIn('syntax error', value['stderr'])
            self.assertFalse(marker.exists())

    def test_multiline_pipelines_output_and_nonzero_exit(self):
        value = probe.shell_operation({'operation': 'command', 'command': "printf 'hello\\n' | tr a-z A-Z\nprintf 'problem\\n' >&2\nexit 7"})
        self.assertTrue(value['syntax_ok'])
        self.assertEqual((value['stdout'], value['stderr'], value['exit_code']), ('HELLO\n', 'problem\n', 7))
        # Bash grammar accepts unknown programs/options; dry run must not claim
        # to have tested command availability or application-specific syntax.
        value = probe.shell_operation({'operation': 'dry_run', 'command': 'missing_program --invalid-option'})
        self.assertTrue(value['syntax_ok'])

    def test_capture_limits_and_timeout_kills_descendants(self):
        script = f"{shlex.quote(sys.executable)} -c " + shlex.quote("import sys; sys.stdout.write('x'*400000); sys.stderr.write('y'*400000)")
        result = probe.capture_script(script, syntax_only=False, timeout=5)
        self.assertEqual(len(result['stdout']), 256 * 1024)
        self.assertEqual(len(result['stderr']), 256 * 1024)
        self.assertTrue(result['truncated'])
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'unexpected'
            script = f'(sleep 0.3; touch {shlex.quote(str(marker))}) & wait'
            result = probe.capture_script(script, syntax_only=False, timeout=.05)
            self.assertTrue(result['timed_out'])
            time.sleep(.4)
            self.assertFalse(marker.exists())

    def test_long_input_is_drained_while_output_is_produced(self):
        script = "printf 'ok\\n'\n" * 2000
        value = probe.shell_operation({'operation': 'command', 'command': script})
        self.assertEqual(value['stdout'], 'ok\n' * 2000)
        self.assertFalse(value['timed_out'])

    def test_commands_cannot_consume_following_script_lines_as_stdin(self):
        value = probe.shell_operation({'operation': 'command', 'command': "cat\nprintf 'still executed\\n'\n"})
        self.assertEqual(value['stdout'], 'still executed\n')
        self.assertEqual(value['exit_code'], 0)

    def test_missing_bash_and_invalid_payload_do_not_spawn(self):
        with patch.object(probe.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Bash is not available'):
                probe.shell_operation({'operation': 'dry_run', 'command': 'true'})
        with patch.object(probe.subprocess, 'Popen') as spawn:
            for script in ('', ' ', 'echo \0', 'x' * 32769):
                with self.assertRaises(ValueError):
                    probe.shell_operation({'operation': 'command', 'command': script})
            spawn.assert_not_called()

    def test_risks_cover_wrappers_paths_nested_commands_and_common_mutations(self):
        cases = [
            ('sudo /bin/rm -rf /tmp/example', {'delete', 'privilege'}),
            ('find /tmp -type f -delete', {'delete'}),
            ('chmod -R 777 /data; chown user /data', {'permissions'}),
            ('sh -c "rm -rf /tmp/example; chmod 777 /data"', {'delete', 'permissions', 'dynamic'}),
            ('apt update && apt install -y htop', {'packages'}),
            ('systemctl restart nginx; pkill worker', {'services'}),
            ('reboot', {'system'}),
            ('mkfs.ext4 /dev/example', {'disk'}),
            ('iptables -F', {'network'}),
            ('echo data > /tmp/file', {'write'}),
            ('curl https://example.test/script | bash', {'dynamic'}),
            ('"$COMMAND" "$TARGET"', {'dynamic'}),
        ]
        for script, expected in cases:
            with self.subTest(script=script):
                warnings = probe.command_risks(script)
                for kind in expected:
                    self.assertIn(probe.RISK_MESSAGES[kind], warnings)
        self.assertEqual(probe.command_risks('df -h\nuptime'), [])
        self.assertIn(probe.RISK_MESSAGES['privilege'], probe.command_risks('id', elevated=True))


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

    def test_command_can_run_without_dry_run_and_still_requires_warning_acknowledgement(self):
        body = {'operation': 'command', 'servers': ['gpu1', 'cpu1'], 'command': 'chmod 640 /tmp/example'}
        with patch.object(self.service, 'run_remote') as remote:
            response = self.post('/api/operations', body)
            self.assertEqual(response.status_code, 400)
            self.assertIn('Acknowledge', response.json()['detail'])
            remote.assert_not_called()
        sample = {'checked_at': self.db.now(), 'syntax_ok': True, 'exit_code': 0, 'dry_run': False,
                  'risk_warnings': probe.command_risks(body['command'])}
        with patch.object(self.service, 'run_remote', return_value=sample) as remote:
            response = self.post('/api/operations', {**body, 'risk_acknowledged': True})
            self.assertEqual(response.status_code, 202, response.text)
            result = self.await_job(response.json()['id'])
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(remote.call_count, 2)
        with patch.object(self.service, 'run_remote', return_value={**sample, 'risk_warnings': []}):
            response = self.post('/api/operations', {**body, 'command': 'echo ok', 'servers': ['gpu1']})
            self.assertEqual(response.status_code, 202, response.text)
            self.assertEqual(self.await_job(response.json()['id'])['status'], 'completed')
        self.assertFalse(self.db.rows("SELECT id FROM operation_jobs WHERE operation='dry_run'"))
        self.assertFalse(self.main.operation_lock.locked())

    def test_local_risk_review_requires_auth_and_never_contacts_servers_or_creates_jobs(self):
        body = {'operation': 'command', 'servers': ['gpu1'], 'command': 'rm /tmp/example; chmod 640 /tmp/other'}
        self.assertEqual(self.client.post('/api/operations/review', json=body).status_code, 403)
        with patch.object(self.service, 'run_remote') as remote:
            response = self.post('/api/operations/review', body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertIn(probe.RISK_MESSAGES['delete'], response.json()['warnings'])
            self.assertIn(probe.RISK_MESSAGES['permissions'], response.json()['warnings'])
            self.assertNotIn(body['command'], response.text)
            self.assertEqual(self.post('/api/operations/review', {**body, 'command': 'id', 'elevated': True}).json()['warnings'], [probe.RISK_MESSAGES['privilege']])
            self.assertEqual(self.post('/api/operations/review', {**body, 'command': 'echo ok'}).json()['warnings'], [])
            for change in ({'command': ' '}, {'servers': ['unknown']}, {'operation': 'inspect'}):
                self.assertEqual(self.post('/api/operations/review', {**body, **change}).status_code, 400)
            remote.assert_not_called()
        self.assertFalse(self.db.rows('SELECT * FROM operation_jobs'))
        self.db.execute("UPDATE servers SET enabled=0 WHERE name='gpu1'")
        self.assertEqual(self.post('/api/operations/review', body).status_code, 400)

    def test_failed_dry_run_and_nonzero_exit_retain_output_and_status(self):
        body = {'operation': 'dry_run', 'servers': ['gpu1', 'cpu1'], 'command': 'echo ok'}
        failed = {'checked_at': self.db.now(), 'syntax_ok': False, 'exit_code': 2, 'stderr': 'syntax error', 'stdout': ''}
        passed = {**failed, 'syntax_ok': True, 'exit_code': 0, 'stderr': ''}
        with patch.object(self.service, 'run_remote', side_effect=[failed, passed]):
            response = self.post('/api/operations', body)
            result = self.await_job(response.json()['id'])
        self.assertEqual(result['status'], 'partial')
        gpu = next(r for r in result['results'] if r['server_name'] == 'gpu1')
        self.assertEqual(gpu['status'], 'failed')
        self.assertEqual(gpu['result']['stderr'], 'syntax error')
        # A previous failed optional check does not block the execution route.
        with patch.object(self.service, 'run_remote', side_effect=[{**passed, 'exit_code': 7, 'stderr': 'command failed'}, passed]):
            response = self.post('/api/operations', {**body, 'operation': 'command'})
            self.assertEqual(response.status_code, 202, response.text)
            result = self.await_job(response.json()['id'])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(next(r for r in result['results'] if r['server_name'] == 'gpu1')['result']['exit_code'], 7)
        self.assertNotIn('command failed', json.dumps(self.db.rows('SELECT * FROM audit_log')))

    def test_command_validation_auth_and_all_servers_above_old_limit(self):
        body = {'operation': 'dry_run', 'servers': ['gpu1'], 'command': 'echo ok'}
        self.assertEqual(self.client.post('/api/operations', json=body).status_code, 403)
        for change in ({'command': ''}, {'command': '\0'}, {'command': 'x' * 32769}, {'timeout': 9}, {'servers': []}):
            self.assertIn(self.post('/api/operations', {**body, **change}).status_code, (400, 422))
        for i in range(55):
            self.db.execute('INSERT INTO servers(name,hostname,port,ssh_user,key_path,enabled) VALUES(?,?,22,?,?,1)',
                            (f'host-{i}', 'host.test', 'user', '/tmp/test-key'))
        names = [s['name'] for s in self.db.rows('SELECT name FROM servers WHERE enabled=1')]
        with patch.object(self.service, 'run_remote', return_value={'checked_at': self.db.now(), 'syntax_ok': True, 'exit_code': 0}) as remote:
            response = self.post('/api/operations', {**body, 'servers': names})
            self.assertEqual(response.status_code, 202, response.text)
            result = self.await_job(response.json()['id'])
            self.assertEqual(len(result['results']), len(names))
            self.assertEqual(remote.call_count, len(names))

    def test_command_diagnostics_are_persisted_in_details_and_history(self):
        base = {'checked_at': self.db.now(), 'syntax_ok': True, 'dry_run': False,
                'exit_code': 0, 'stdout': '', 'stderr': ''}
        samples = [
            {**base, 'stdout': 'Could not execute systemctl: at /usr/bin/deb-systemd-invoke line 148.\n'},
            {**base, 'stderr': 'debconf: unable to initialize frontend: Dialog\n'},
            {**base, 'stderr': 'Downloading 100%\n0 errors\n'},
        ]
        with patch.object(self.service, 'run_remote', side_effect=samples):
            response = self.post('/api/operations', {'operation': 'command', 'servers': ['cpu1', 'gpu1', 'gpu2'], 'command': 'echo ok'})
            self.assertEqual(response.status_code, 202, response.text)
            job = self.await_job(response.json()['id'])
        self.assertEqual(job['status'], 'completed_with_warnings')
        self.assertEqual([item['status'] for item in job['results']], ['completed_with_warnings', 'completed_with_warnings', 'completed'])
        for item, sample in zip(job['results'], samples):
            value = item['result']
            self.assertEqual((value['exit_code'], value['stdout'], value['stderr']), (0, sample['stdout'], sample['stderr']))
            saved = self.db.row('SELECT result_json FROM operation_results WHERE job_id=? AND server_name=?', (job['id'], item['server_name']))
            self.assertEqual(json.loads(saved['result_json']), value)
        self.assertEqual(job['results'][0]['result']['output_diagnostics'][0]['stream'], 'stdout')
        self.assertEqual(job['results'][1]['result']['output_diagnostics'][0]['stream'], 'stderr')
        self.assertEqual(job['results'][2]['result']['output_diagnostics'], [])
        history = self.client.get('/api/operations').json()
        self.assertEqual(history['jobs'][0]['status'], 'completed_with_warnings')
        self.assertNotIn('Could not execute systemctl', json.dumps(self.db.rows('SELECT * FROM audit_log')))

    def test_output_diagnostics_do_not_override_failures_or_classify_dry_runs(self):
        body = {'operation': 'command', 'servers': ['cpu1', 'gpu1'], 'command': 'echo ok'}
        warning = {'checked_at': self.db.now(), 'syntax_ok': True, 'exit_code': 0, 'stdout': 'ERROR: problem\n'}
        with patch.object(self.service, 'run_remote', side_effect=[{**warning, 'exit_code': 100}, warning]):
            job = self.await_job(self.post('/api/operations', body).json()['id'])
        self.assertEqual(job['status'], 'partial')
        self.assertEqual([item['status'] for item in job['results']], ['failed', 'completed_with_warnings'])
        self.assertEqual([item['result']['exit_code'] for item in job['results']], [100, 0])
        self.assertTrue(job['results'][0]['result']['output_diagnostics'])
        with patch.object(self.service, 'run_remote', return_value=warning):
            job = self.await_job(self.post('/api/operations', {**body, 'operation': 'dry_run'}).json()['id'])
        self.assertEqual(job['status'], 'completed')
        self.assertNotIn('output_diagnostics', job['results'][0]['result'])

    def test_startup_backfills_saved_output_once_without_remote_work_or_changing_evidence(self):
        created_at, finished_at = '2026-10-01T00:00:00+00:00', '2026-10-01T00:01:00+00:00'
        original = {'syntax_ok': True, 'exit_code': 0, 'stdout': 'Could not execute systemctl: example\n',
                    'stderr': 'debconf: falling back to frontend: Teletype\n', 'checked_at': finished_at}
        def saved_job(operation, status, host_status):
            job_id = self.db.execute('INSERT INTO operation_jobs(operation,payload_json,status,created_at,finished_at) VALUES(?,?,?,?,?)',
                                     (operation, '{"command":"echo example"}', status, created_at, finished_at))
            self.db.execute('INSERT INTO operation_results(job_id,server_name,status,result_json,started_at,finished_at) VALUES(?,?,?,?,?,?)',
                            (job_id, 'cpu1', host_status, json.dumps(original), created_at, finished_at))
            return job_id
        completed = saved_job('command', 'completed', 'completed')
        failed = saved_job('command', 'failed', 'failed')
        interrupted = saved_job('command', 'interrupted', 'interrupted')
        legacy = saved_job('inspect', 'completed', 'completed')
        with patch.object(self.service, 'run_remote') as remote:
            self.main.startup()
            job = self.client.get(f'/api/operations/{completed}').json()
            self.assertEqual(job['status'], 'completed_with_warnings')
            item = job['results'][0]
            self.assertEqual(item['status'], 'completed_with_warnings')
            self.assertEqual((item['started_at'], item['finished_at']), (created_at, finished_at))
            self.assertEqual((job['created_at'], job['finished_at']), (created_at, finished_at))
            self.assertEqual({key: item['result'][key] for key in original}, original)
            history = {entry['id']: entry['status'] for entry in self.client.get('/api/operations').json()['jobs']}
            self.assertEqual(history, {completed: 'completed_with_warnings', failed: 'failed', interrupted: 'interrupted', legacy: 'completed'})
            self.assertTrue(item['result']['output_diagnostics'])
            before = self.db.rows('SELECT * FROM operation_results ORDER BY job_id')
            with patch.object(self.service, 'analyze_output', side_effect=AssertionError('Already migrated')):
                self.main.startup()
            self.assertEqual(self.db.rows('SELECT * FROM operation_results ORDER BY job_id'), before)
            remote.assert_not_called()
        self.assertNotIn('output_diagnostics', self.service.job_detail(legacy)['results'][0]['result'])

    def test_dry_run_never_elevates_and_command_transport_budget_includes_timeout(self):
        from app import native_ssh
        sample = {'checked_at': self.db.now(), 'syntax_ok': True, 'exit_code': 0}
        with patch.dict(os.environ, {'MOSSENTRY_SSH_ENGINE': 'native'}), patch.object(native_ssh, 'execute', return_value=json.dumps(sample)) as execute:
            self.service.run_remote('gpu1', {'operation': 'dry_run', 'command': 'id', 'elevated': True})
            self.assertFalse(execute.call_args.kwargs['sudo'])
            self.service.run_remote('gpu1', {'operation': 'command', 'command': 'id', 'elevated': True, 'timeout': 600})
            self.assertTrue(execute.call_args.kwargs['sudo'])
            self.assertEqual(execute.call_args.kwargs['timeout'], 630)
