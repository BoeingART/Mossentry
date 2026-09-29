import json
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from app import monitoring_service as service, resource_probe as probe


class ResourceProbeTests(unittest.TestCase):
    def test_cpu_interval_attribution_and_pid_reuse(self):
        before = (1000, 400, 4, {(10, 1): (1000, 50), (20, 1): (1001, 100), (30, 1): (1000, 100)}, False)
        after = (1400, 500, 4, {(10, 1): (1000, 150), (20, 2): (1001, 150), (30, 1): (1000, 150)}, True)
        with patch.object(probe, 'username', side_effect=lambda uid: {1000: 'alice', 1001: 'bob'}[uid]):
            result = probe.cpu_usage(before, after)
        self.assertEqual(result['percent'], 75)
        self.assertEqual(result['cores'], 4)
        self.assertEqual(result['users'], [
            {'username': 'alice', 'cpu_percent': 37.5, 'processes': 2},
            {'username': 'bob', 'cpu_percent': 0, 'processes': 1},
        ])
        self.assertTrue(result['restricted'])

    def test_effective_process_owner(self):
        with patch.object(probe.Path, 'read_text', return_value='Name:\tpython\nUid:\t1000\t1001\t1002\t1003\n'):
            self.assertEqual(probe.process_owner(123), 1001)

    def test_gpu_process_metrics_and_unsupported_values(self):
        outputs = [
            '0, GPU-one, NVIDIA A100, 75, 4096, 40960, 60\n1, GPU-two, NVIDIA A100, N/A, 0, 40960, 40',
            'GPU-one, 101, 1024\nGPU-one, 102, [N/A]\n',
            '# gpu pid type sm mem enc dec command\n0 101 C 25 10 - - python\n0 102 C - - - - python\n1 - - - - - - -',
        ]
        with patch.object(probe.shutil, 'which', return_value='/usr/bin/nvidia-smi'), \
             patch.object(probe, 'smi', side_effect=outputs), \
             patch.object(probe, 'process_owner', side_effect=[1000, PermissionError()]), \
             patch.object(probe, 'username', return_value='alice'):
            result = probe.gpu_usage()
        self.assertEqual(result['status'], 'ok')
        first, second = result['devices']
        self.assertEqual(first['percent'], 75)
        self.assertEqual(first['processes'][0], {'pid': 101, 'username': 'alice', 'sm_percent': 25, 'memory_mb': 1024})
        self.assertIsNone(first['processes'][1]['username'])
        self.assertIsNone(first['processes'][1]['sm_percent'])
        self.assertIsNone(first['processes'][1]['memory_mb'])
        self.assertIsNone(second['percent'])
        self.assertFalse(second['process_utilization_available'])

    def test_missing_gpu_driver_and_partial_support(self):
        with patch.object(probe.shutil, 'which', return_value=None):
            self.assertEqual(probe.gpu_usage()['status'], 'unavailable')
        with patch.object(probe.shutil, 'which', return_value='/usr/bin/nvidia-smi'), \
             patch.object(probe, 'smi', side_effect=['0, GPU-one, NVIDIA, 50, 1000, 4000, 60', RuntimeError(), subprocess.TimeoutExpired('smi', 6)]):
            result = probe.gpu_usage()
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(result['devices'][0]['percent'], 50)
            self.assertFalse(result['devices'][0]['process_memory_available'])
        for value in ('N/A', '-', '[Not Supported]', 'nan', 'inf', '-1'):
            self.assertIsNone(probe.number(value))

    def test_disks_include_data_mounts_and_reserved_blocks(self):
        mounts = '/dev/root / ext4 rw 0 0\n/dev/sdb /data\\040disk xfs rw 0 0\n/dev/sdb /bind xfs rw 0 0\nproc /proc proc rw 0 0\n'
        with patch.object(probe.Path, 'read_text', return_value=mounts), \
             patch.object(probe.os, 'stat', side_effect=lambda path: SimpleNamespace(st_dev=1 if path == '/' else 2)), \
             patch.object(probe.os, 'statvfs', return_value=SimpleNamespace(f_blocks=100, f_bfree=50, f_bavail=40, f_frsize=1024 ** 3)):
            result, unavailable = probe.disks()
        self.assertEqual([item['mount'] for item in result], ['/', '/data disk'])
        self.assertEqual(result[0]['percent'], 55.6)
        self.assertEqual(result[0]['used_gb'], 50)
        self.assertEqual(unavailable, [])


class MonitoringServiceTests(unittest.TestCase):
    def setUp(self):
        service._cache.clear()
        service._inflight.clear()
        self.server = {'id': 1, 'hostname': '2001:db8::1', 'port': 2222, 'ssh_user': 'operator', 'key_path': '/private/key with spaces'}
        self.sample = {'checked_at': '2026-09-29T00:00:00+00:00', 'cpu': {}, 'memory': {}, 'disks': [], 'gpu': {}, 'warnings': []}
        self.result = subprocess.CompletedProcess([], 0, json.dumps(self.sample), '')

    def test_secure_ssh_cache_and_connection_changes(self):
        with patch.object(service.subprocess, 'run', return_value=self.result) as run:
            self.assertEqual(service.inspect_resources(self.server), self.sample)
            self.assertEqual(service.inspect_resources(self.server), self.sample)
            run.assert_called_once()
            command = run.call_args.args[0]
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertIn('BatchMode=yes', command)
            self.assertIn('/private/key with spaces', command)
            self.assertEqual(command[-2:], ['operator@2001:db8::1', '/usr/bin/python3 -'])
            self.assertNotIn('shell', run.call_args.kwargs)
            self.assertIn('def collect()', run.call_args.kwargs['input'])
            service.inspect_resources({**self.server, 'hostname': 'new.example.test'})
            self.assertEqual(run.call_count, 2)
            with patch.object(service.time, 'monotonic', return_value=10 ** 15):
                service.inspect_resources(self.server)
            self.assertEqual(run.call_count, 3)

    def test_one_sample_per_host_and_independent_hosts(self):
        entered, release = Event(), Event()
        def run(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return self.result
        with patch.object(service.subprocess, 'run', side_effect=run), ThreadPoolExecutor() as executor:
            pending = executor.submit(service.inspect_resources, self.server)
            self.assertTrue(entered.wait(3))
            try:
                with self.assertRaises(service.SampleBusy):
                    service.inspect_resources(self.server)
                with patch.object(service.subprocess, 'run', return_value=self.result):
                    self.assertEqual(service.inspect_resources({**self.server, 'id': 2}), self.sample)
            finally:
                release.set()
            self.assertEqual(pending.result(), self.sample)

    def test_failure_releases_lock_and_does_not_cache(self):
        for result in (subprocess.TimeoutExpired('ssh', 30), subprocess.CompletedProcess([], 1, '', 'Permission denied SECRET'), subprocess.CompletedProcess([], 0, 'bad json', '')):
            with patch.object(service.subprocess, 'run', side_effect=result if isinstance(result, Exception) else None, return_value=result):
                with self.assertRaises((RuntimeError, ValueError, subprocess.TimeoutExpired)):
                    service.inspect_resources(self.server)
            self.assertFalse(service._inflight)
            self.assertFalse(service._cache)
