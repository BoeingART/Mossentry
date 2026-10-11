from __future__ import annotations

import os
import json
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import ansible_service
from app.errors import friendly_error


class SSHRuntimeTests(unittest.TestCase):
    def test_host_passwords_override_fallback_without_leaking_and_are_cleaned_up(self):
        for outcome in ('success', 'failure', 'timeout'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as tmp:
                data_dir = Path(tmp)
                (data_dir / 'jobs').mkdir()
                inventories = []
                servers = [{'name': name, 'hostname': 'example.test', 'port': 22,
                            'ssh_user': 'operator', 'key_path': '/test/key'} for name in ('gpu1', 'gpu2', 'gpu3')]

                def run(command, **kwargs):
                    inventory = Path(command[command.index('-i') + 1])
                    inventories.append(inventory)
                    self.assertEqual(inventory.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(inventory.parent.stat().st_mode & 0o777, 0o700)
                    hosts = json.loads(inventory.read_text())['all']['children']['managed']['hosts']
                    self.assertEqual(hosts['gpu1']['ansible_become_password'], 'first-secret')
                    self.assertEqual(hosts['gpu2']['ansible_become_password'], 'legacy-secret')
                    self.assertNotIn('ansible_become_password', hosts['gpu3'])
                    extra = json.loads(Path(command[command.index('--extra-vars') + 1][1:]).read_text())
                    self.assertNotIn('ansible_become_password', extra)
                    self.assertNotIn('first-secret', str(command))
                    if outcome == 'timeout':
                        raise subprocess.TimeoutExpired(command, 30, output=b'first-secret legacy-secret')
                    return subprocess.CompletedProcess(command, int(outcome == 'failure'), 'first-secret legacy-secret', '')

                with patch.object(ansible_service, 'DATA_DIR', data_dir), \
                     patch.object(ansible_service, '_enabled_servers', return_value=servers), \
                     patch.object(ansible_service, 'rows', return_value=[{'name': 'gpu1', 'sudo_password': 'first-secret'}]), \
                     patch.object(ansible_service, '_become_password', return_value='legacy-secret'), \
                     patch.object(ansible_service, '_ansible_playbook', return_value='ansible-playbook'), \
                     patch.object(ansible_service.subprocess, 'run', side_effect=run):
                    result = ansible_service._run('scan_users.yml', 'gpu1,gpu2', {'scan_output_dir': tmp}, timeout=30)
                self.assertEqual(result.ok, outcome == 'success')
                self.assertNotIn('first-secret', result.output)
                self.assertNotIn('legacy-secret', result.output)
                self.assertEqual(len(inventories), 1)
                self.assertFalse(inventories[0].exists())
                self.assertFalse((data_dir / 'inventory.json').exists())
                self.assertEqual(list((data_dir / 'jobs').glob('*.json')), [])

    def test_saved_password_does_not_require_legacy_password_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            (data_dir / 'jobs').mkdir()
            server = {'name': 'gpu1', 'hostname': 'example.test', 'port': 22,
                      'ssh_user': 'operator', 'key_path': '/test/key'}
            with patch.object(ansible_service, 'DATA_DIR', data_dir), \
                 patch.object(ansible_service, '_enabled_servers', return_value=[server]), \
                 patch.object(ansible_service, 'rows', return_value=[{'name': 'gpu1', 'sudo_password': 'saved-secret'}]), \
                 patch.object(ansible_service, '_become_password', side_effect=AssertionError('Must not read fallback')), \
                 patch.object(ansible_service, '_ansible_playbook', return_value='ansible-playbook'), \
                 patch.object(ansible_service.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'ok', '')):
                self.assertTrue(ansible_service._run('scan_users.yml', 'gpu1').ok)

    def test_sudo_errors_explain_password_setup(self):
        self.assertIn('Edit this server', friendly_error('Missing sudo password'))
        self.assertIn('rejected', friendly_error('Incorrect sudo password'))

    def test_short_private_socket_path_and_cleanup(self):
        for timed_out in (False, True):
            with self.subTest(timed_out=timed_out), tempfile.TemporaryDirectory() as tmp:
                data_dir = Path(tmp) / 'Application Support' / ('long-app-name-' * 12)
                (data_dir / 'jobs').mkdir(parents=True)
                socket_dirs = []

                def run(command, **kwargs):
                    env = kwargs['env']
                    directory = Path(env['ANSIBLE_SSH_CONTROL_PATH_DIR'])
                    socket_dirs.append(directory)
                    self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(env['ANSIBLE_HOST_KEY_CHECKING'], 'True')
                    # OpenSSH expands %C to a 40-character hash and appends a
                    # random suffix while binding the initial master socket.
                    template = env['ANSIBLE_SSH_CONTROL_PATH'] % {'directory': directory}
                    socket_path = template.replace('%C', 'a' * 40) + '.' + 'b' * 16
                    self.assertLess(len(os.fsencode(socket_path)), 104)
                    with socket.socket(socket.AF_UNIX) as sock:
                        sock.bind(socket_path)
                    if timed_out:
                        raise subprocess.TimeoutExpired(command, 30)
                    return subprocess.CompletedProcess(command, 0, 'pong', '')

                server = {'name': 'cpu1', 'hostname': 'example.test', 'port': 20901,
                          'ssh_user': 'operator', 'key_path': '/test/key'}
                with patch.object(ansible_service, 'DATA_DIR', data_dir), \
                     patch.object(ansible_service, '_enabled_servers', return_value=[server]), \
                     patch.object(ansible_service, '_ansible_playbook', return_value='ansible-playbook'), \
                     patch.object(ansible_service.subprocess, 'run', side_effect=run):
                    result = ansible_service._run('test_connection.yml', 'cpu1', {'test': True}, timeout=30)
                self.assertEqual(result.ok, not timed_out)
                self.assertEqual(len(socket_dirs), 1)
                self.assertFalse(socket_dirs[0].exists())
                self.assertEqual(list((data_dir / 'jobs').glob('*.json')), [])

    def test_socket_path_error_is_not_reported_as_network_failure(self):
        for message in ('ControlPath too long', 'unix_listener: path too long for Unix domain socket'):
            raw = f'UNREACHABLE! {message}: /Users/private/SECRET'
            error = friendly_error(raw)
            self.assertIn('local SSH connection path', error)
            self.assertNotIn('SECRET', error)
            self.assertNotIn('network', error)
