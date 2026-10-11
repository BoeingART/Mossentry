from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import socket
import threading
import subprocess
import unittest
from unittest.mock import MagicMock, patch

from app import native_ssh


class NativeSSHTests(unittest.TestCase):
    def test_sudo_password_consumed_or_skipped_both_preserve_the_request(self):
        source = 'from __future__ import annotations\nimport json, sys\nprint(json.loads(sys.stdin.readline())["value"])'
        program = native_ssh.framed_program(source, 'fixture-marker')
        for prefix in ['', 'saved-sudo-password\n']:
            result = subprocess.run([sys.executable, '-c', program],
                                    input=prefix + 'fixture-marker\n{"value":"correct"}\n',
                                    text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout.strip(), 'correct')

    def test_real_loopback_ssh_connection_checks_known_host_and_authenticates(self):
        # A disposable protocol fixture, never a configured/real server.
        host_key = native_ssh.paramiko.RSAKey.generate(2048)
        user_key = native_ssh.paramiko.RSAKey.generate(2048)
        received = []
        ready = threading.Event()

        class Server(native_ssh.paramiko.ServerInterface):
            def check_auth_publickey(self, username, key):
                return (native_ssh.paramiko.AUTH_SUCCESSFUL if username == 'fixture' and key == user_key
                        else native_ssh.paramiko.AUTH_FAILED)

            def check_channel_request(self, kind, channel_id):
                return native_ssh.paramiko.OPEN_SUCCEEDED

            def check_channel_exec_request(self, channel, command):
                received.append(command.decode())
                ready.set()
                return True

        with tempfile.TemporaryDirectory() as directory, socket.socket() as listener:
            home = Path(directory)
            (home / '.ssh').mkdir()
            key_path = home / '.ssh/key'
            user_key.write_private_key_file(str(key_path))
            key_path.chmod(0o600)
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            listener.settimeout(10)
            port = listener.getsockname()[1]
            (home / '.ssh/known_hosts').write_text(f'[127.0.0.1]:{port} {host_key.get_name()} {host_key.get_base64()}\n')

            def serve():
                connection, _ = listener.accept()
                with native_ssh.paramiko.Transport(connection) as transport:
                    transport.add_server_key(host_key)
                    transport.start_server(server=Server())
                    channel = transport.accept(10)
                    if channel is None or not ready.wait(10):
                        return
                    while channel.recv(65536):
                        pass
                    channel.sendall(b'{"ping":"pong"}')
                    channel.send_exit_status(0)
                    channel.close()

            worker = threading.Thread(target=serve, daemon=True)
            worker.start()
            with patch.object(native_ssh.Path, 'home', return_value=home):
                response = native_ssh.execute({'hostname': '127.0.0.1', 'port': port,
                                               'ssh_user': 'fixture', 'key_path': str(key_path)},
                                              'print("fixture")', timeout=10)
            worker.join(10)
            self.assertEqual(response, '{"ping":"pong"}')
            self.assertIn('/usr/bin/python3 -c', received[0])

    def test_strict_host_verification_no_agent_and_password_only_on_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / 'private key'
            key.write_text('fixture')
            key.chmod(0o600)
            client = MagicMock()
            # Configure the returned file objects explicitly.
            stdin, stdout, stderr = MagicMock(), MagicMock(), MagicMock()
            stdout.channel.recv_ready.return_value = False
            stdout.channel.recv_stderr_ready.return_value = False
            stdout.channel.exit_status_ready.return_value = True
            stdout.channel.recv_exit_status.return_value = 0
            client.exec_command.return_value = (stdin, stdout, stderr)
            server = {'hostname': 'host.test', 'port': 2222, 'ssh_user': 'operator', 'key_path': str(key)}
            with patch.object(native_ssh.paramiko, 'SSHClient', return_value=client):
                native_ssh.execute(server, 'print("ok")', {'name': 'a; touch /tmp/no'}, sudo=True, password='test-secret')
            self.assertIsInstance(client.set_missing_host_key_policy.call_args.args[0], native_ssh.paramiko.RejectPolicy)
            self.assertFalse(client.connect.call_args.kwargs['allow_agent'])
            self.assertFalse(client.connect.call_args.kwargs['look_for_keys'])
            command = client.exec_command.call_args.args[0]
            self.assertIn('sudo -S', command)
            self.assertNotIn('test-secret', command)
            self.assertNotIn('touch /tmp/no', command)
            self.assertEqual(stdin.write.call_args_list[0].args, ('test-secret\n',))
            client.close.assert_called_once()

    def test_failed_connection_closes_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / 'key'
            key.touch(mode=0o600)
            client = MagicMock()
            client.connect.side_effect = RuntimeError('Host key mismatch')
            with patch.object(native_ssh.paramiko, 'SSHClient', return_value=client):
                with self.assertRaisesRegex(RuntimeError, 'Host key mismatch'):
                    native_ssh.execute({'hostname': 'host', 'port': 22, 'ssh_user': 'op', 'key_path': str(key)}, '')
            client.close.assert_called_once()

    def test_scan_results_are_written_locally_and_errors_redact_sudo_passwords(self):
        with tempfile.TemporaryDirectory() as directory:
            servers = [{'name': 'first', 'ssh_user': 'op'}, {'name': 'second', 'ssh_user': 'op'}]
            with patch.object(native_ssh, 'execute', side_effect=['{"passwd":"sample"}', RuntimeError('secret rejected')]):
                ok, output = native_ssh.run('scan_users.yml', servers, {'scan_output_dir': directory}, {'second': 'secret'}, 30)
            self.assertFalse(ok)
            self.assertNotIn('secret', output)
            self.assertIn('second', output)
            self.assertTrue((Path(directory) / 'first.json').exists())
            self.assertFalse((Path(directory) / 'second.json').exists())

    def test_generated_key_is_openssh_and_fingerprint_matches(self):
        from app import ansible_service
        from cryptography.hazmat.primitives import serialization
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'keys').mkdir()
            with patch.object(ansible_service, 'DATA_DIR', Path(directory)):
                private, public, fingerprint = ansible_service._generate_key(1, 'alice')
                loaded = serialization.load_ssh_private_key(private.read_bytes(), password=None)
                self.assertTrue(public.startswith('ssh-ed25519 '))
                expected = base64.b64encode(hashlib.sha256(base64.b64decode(public.split()[1])).digest()).decode().rstrip('=')
                self.assertEqual(fingerprint, 'SHA256:' + expected)
                self.assertIsNotNone(loaded)
                with self.assertRaises(RuntimeError):
                    ansible_service._generate_key(1, 'alice')


@unittest.skipIf(os.name == 'nt', 'Remote program executes only on Unix servers')
class RemoteSafetyTests(unittest.TestCase):
    def test_protected_and_missing_accounts_are_rejected_before_commands(self):
        from app import remote_actions
        with patch.object(remote_actions.sys, 'platform', 'linux'), \
             patch.object(remote_actions, 'account', return_value=MagicMock(pw_uid=0)), \
             patch.object(remote_actions.os, 'geteuid', return_value=0), \
             patch.object(remote_actions, 'command') as command:
            for name in ['root', 'nobody', 'operator', 'bad;name']:
                with self.assertRaises(ValueError):
                    remote_actions.run({'operation': 'delete_user', 'managed_username': name, 'ssh_user': 'operator'})
            command.assert_not_called()

    def test_delete_keeps_home_and_does_not_force(self):
        from app import remote_actions
        with patch.object(remote_actions, 'account', return_value=MagicMock(pw_uid=1001)), \
             patch.object(remote_actions.os, 'geteuid', return_value=0), \
             patch.object(remote_actions.sys, 'platform', 'linux'), \
             patch.object(remote_actions, 'command') as command:
            remote_actions.run({'operation': 'delete_user', 'managed_username': 'alice', 'ssh_user': 'operator'})
            command.assert_called_once_with(['userdel', 'alice'])


if __name__ == '__main__':
    unittest.main()
