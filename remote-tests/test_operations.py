import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src-tauri" / "remote"))
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

import operations_probe as probe

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
