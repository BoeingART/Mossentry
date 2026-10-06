import json
import os
import tempfile
from pathlib import Path
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app import monitoring_service as service, resource_probe as probe


class ResourceProbeTests(unittest.TestCase):
    def setUp(self):
        nvml = patch.object(probe, 'nvml_process_utilization', return_value={})
        self.nvml = nvml.start()
        self.addCleanup(nvml.stop)

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
        self.assertEqual(first['processes'][0], {'pid': 101, 'username': 'alice', 'sm_percent': 25, 'memory_mb': 1024, 'kind': 'C', 'name': 'python', 'sm_source': 'pmon'})
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

    def test_gpu_idle_activity_and_graphics_memory(self):
        outputs = [
            '0, GPU-one, RTX 3090, 0, 5396, 24576, 25',
            'GPU-one, 101, 5392',
            '# gpu pid type sm mem enc dec jpg ofa fb ccpm command\n'
            '0 101 C - - - - - - 5392 0 python3.10\n'
            '0 16066 G - - - - - - 4 0 Xorg',
        ]
        for status, samples, expected in [('no_activity', {}, 0), ('ok', {101: 80}, 80), ('unsupported', {}, None), ('unavailable', {}, None)]:
            with self.subTest(status=status), \
                 patch.object(probe.shutil, 'which', return_value='/usr/bin/nvidia-smi'), \
                 patch.object(probe, 'smi', side_effect=outputs), \
                 patch.object(probe, 'process_owner', return_value=1000), \
                 patch.object(probe, 'username', return_value='alice'):
                self.nvml.return_value = {'GPU-one': {'status': status, 'samples': samples}}
                device = probe.gpu_usage()['devices'][0]
            compute, graphics = device['processes']
            self.assertEqual(compute['sm_percent'], expected)
            self.assertEqual(graphics['memory_mb'], 4)
            self.assertEqual(graphics['kind'], 'G')
            self.assertEqual(graphics['name'], 'Xorg')
            self.assertEqual(device['process_utilization_status'], status)
            self.assertEqual(device['process_utilization_available'], expected is not None)
            if expected is not None:
                self.assertEqual(graphics['sm_percent'], 0)
                self.assertEqual(graphics['sm_source'], 'no_activity')

    def test_pmon_latest_cycle_replaces_old_samples_and_uses_named_columns(self):
        result = probe.parse_pmon('# gpu pid type sm mem enc dec fb command\n'
                                  '0 101 C 80 5 - - 5392 python\n'
                                  '0 101 C - - - - 5392 python\n'
                                  '1 - - - - - - - -')
        self.assertEqual(len(result), 1)
        self.assertIsNone(result[(0, 101)]['sm_percent'])
        self.assertEqual(result[(0, 101)]['memory_mb'], 5392)

    def test_physical_topology_resolves_partitions_lvm_and_raid(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'class/block'
            root.mkdir(parents=True)

            def node(name, identity, parent=None, virtual=False, slaves=(), optical=False):
                target = (Path(temp) / ('devices/virtual/block' if virtual else 'devices/pci/block') / name) if parent is None else (root / parent).resolve() / name
                target.mkdir(parents=True)
                (target / 'dev').write_text(identity)
                (target / 'size').write_text('2097152')
                (target / 'slaves').mkdir()
                (root / name).symlink_to(target, target_is_directory=True)
                if parent:
                    (target / 'partition').write_text('1')
                elif not virtual:
                    (target / 'device').mkdir()
                    (target / 'device/model').write_text('TEST DRIVE')
                    (target / 'device/type').write_text('5' if optical else '0')
                for slave in slaves:
                    (target / 'slaves' / slave).symlink_to(root / slave, target_is_directory=True)

            node('sda', '8:0')
            node('sda1', '8:1', parent='sda')
            node('nvme0n1', '259:0')
            node('nvme0n1p1', '259:1', parent='nvme0n1')
            node('dm-0', '253:0', virtual=True, slaves=('sda1',))
            node('md0', '9:0', virtual=True, slaves=('dm-0', 'nvme0n1p1'))
            node('loop0', '7:0', virtual=True)
            node('zram0', '252:0', virtual=True)
            node('sr0', '11:0', optical=True)
            physical, mapping = probe.block_topology(root)
        self.assertEqual(set(physical), {'sda', 'nvme0n1'})
        self.assertEqual(physical['sda']['size_bytes'], 1024 ** 3)
        self.assertEqual(mapping['8:1'], {'sda'})
        self.assertEqual(mapping['253:0'], {'sda'})
        self.assertEqual(mapping['9:0'], {'sda', 'nvme0n1'})
        self.assertNotIn('7:0', mapping)
        self.assertNotIn('252:0', mapping)
        self.assertNotIn('11:0', mapping)

    def physical_disks(self):
        return {name: {'name': '/dev/' + name, 'model': 'TEST', 'size_bytes': 100 * 1024 ** 3} for name in ('sda', 'sdb', 'sdc')}

    def test_disk_groups_deduplicate_bind_mounts_and_aggregate_partitions(self):
        mounts = '/dev/sda1 / ext4 rw 0 0\n/dev/sda2 /data\\040disk xfs rw 0 0\n/dev/sda2 /bind xfs rw 0 0\n/dev/loop0 /snap squashfs rw 0 0\nserver:/data /network nfs4 rw 0 0\n'
        mapping = {'8:1': {'sda'}, '8:2': {'sda'}}
        with patch.object(probe, 'block_topology', return_value=(self.physical_disks(), mapping)), \
             patch.object(probe.Path, 'read_text', return_value=mounts), \
             patch.object(probe.os, 'stat', side_effect=lambda path: SimpleNamespace(st_dev=os.makedev(8, 1 if path == '/' else 2) if path != '/snap' else os.makedev(7, 0), st_rdev=os.makedev(7, 0))), \
             patch.object(probe.os, 'statvfs', return_value=SimpleNamespace(f_blocks=40, f_bfree=20, f_bavail=16, f_frsize=1024 ** 3)) as statvfs:
            result, warnings = probe.disks()
        first = result[0]
        self.assertEqual(first['id'], 'sda')
        self.assertEqual(first['total_gb'], 100)
        self.assertEqual(first['filesystem_total_gb'], 80)
        self.assertEqual(first['used_gb'], 40)
        self.assertEqual(first['percent'], 55.6)
        self.assertEqual(first['mounts'], ['/', '/bind', '/data disk'])
        self.assertEqual(statvfs.call_count, 2)
        self.assertEqual(result[1]['status'], 'unmounted')
        self.assertIsNone(result[1]['percent'])
        self.assertEqual(warnings, [])

    def test_shared_storage_counts_each_filesystem_and_physical_disk_once(self):
        gib = 1024 ** 3
        filesystems = [
            {'owners': {'sda'}, 'mounts': ['/boot'], 'usage': {'total': 10*gib, 'used': 5*gib, 'available': 5*gib}},
            {'owners': {'sda', 'sdb'}, 'mounts': ['/data'], 'usage': {'total': 100*gib, 'used': 50*gib, 'available': 50*gib}},
        ]
        result = probe.group_disk_usage(self.physical_disks(), filesystems)
        self.assertEqual(len(result), 2)
        shared, unmounted = result
        self.assertEqual(shared['id'], 'sda+sdb')
        self.assertEqual(shared['total_gb'], 200)
        self.assertEqual(shared['filesystem_total_gb'], 110)
        self.assertEqual(shared['used_gb'], 55)
        self.assertEqual(shared['percent'], 50)
        self.assertTrue(shared['shared'])
        self.assertIsNone(unmounted['used_gb'])
        self.assertIsNone(unmounted['percent'])

    def test_unreadable_filesystems_are_not_reported_as_idle(self):
        with patch.object(probe, 'block_topology', return_value=(self.physical_disks(), {'8:1': {'sda'}})), \
             patch.object(probe.Path, 'read_text', return_value='/dev/sda1 / ext4 rw 0 0'), \
             patch.object(probe.os, 'stat', return_value=SimpleNamespace(st_dev=os.makedev(8, 1))), \
             patch.object(probe.os, 'statvfs', side_effect=PermissionError):
            result, warnings = probe.disks()
        self.assertEqual(result[0]['status'], 'unavailable')
        self.assertIsNone(result[0]['percent'])
        self.assertTrue(warnings)
        with patch.object(probe, 'block_topology', side_effect=FileNotFoundError):
            result, warnings = probe.disks()
        self.assertEqual(result, [])
        self.assertTrue(warnings)


class NetworkProbeTests(unittest.TestCase):
    def test_reads_receive_and_transmit_bytes_without_loopback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            proc = root / 'netdev'
            proc.write_text('Inter-| Receive | Transmit\n'
                            'lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n'
                            'eth0: 1048576 25 0 0 0 0 0 0 2048 10 0 0 0 0 0 0\n'
                            'bad: invalid\n')
            (root / 'eth0/device').mkdir(parents=True)
            (root / 'eth0/ifindex').write_text('2')
            (root / 'eth0/operstate').write_text('up')
            with patch.object(probe.time, 'monotonic', return_value=10):
                timestamp, interfaces = probe.network_snapshot(proc, root)
        self.assertEqual(timestamp, 10)
        self.assertEqual(interfaces, {'eth0': {'identity': 2, 'rx': 1048576, 'tx': 2048, 'physical': True, 'up': True}})

    def test_rates_use_actual_elapsed_time_and_prefer_active_hardware(self):
        ethernet = {'identity': 2, 'rx': 1000, 'tx': 2000, 'physical': True, 'up': True}
        bridge = {**ethernet, 'identity': 3, 'physical': False}
        before = (10, {'eth0': ethernet, 'br0': bridge})
        after = (12, {'eth0': {**ethernet, 'rx': 9000, 'tx': 4000}, 'br0': bridge})
        result = probe.network_usage(before, after)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['interfaces'], [
            {'name': 'eth0', 'rx_bytes_per_second': 4000, 'tx_bytes_per_second': 1000},
            {'name': 'br0', 'rx_bytes_per_second': 0, 'tx_bytes_per_second': 0},
        ])

    def test_counter_resets_new_interfaces_and_replaced_devices_are_unknown(self):
        device = {'identity': 2, 'rx': 1000, 'tx': 2000, 'physical': True, 'up': True}
        before = (10, {'eth0': device, 'removed': device})
        after = (11, {'eth0': {**device, 'rx': 10, 'tx': 3000}, 'new': device})
        result = probe.network_usage(before, after)['interfaces']
        self.assertEqual(result[0], {'name': 'eth0', 'rx_bytes_per_second': None, 'tx_bytes_per_second': 1000})
        self.assertEqual(result[1], {'name': 'new', 'rx_bytes_per_second': None, 'tx_bytes_per_second': None})
        replaced = probe.network_usage(before, (11, {'eth0': {**device, 'identity': 4}}))['interfaces'][0]
        self.assertIsNone(replaced['rx_bytes_per_second'])
        self.assertIsNone(replaced['tx_bytes_per_second'])

    def test_unavailable_counters_do_not_fail_other_metrics_or_report_zero(self):
        with patch.object(probe.Path, 'read_text', side_effect=PermissionError):
            self.assertIsNone(probe.network_snapshot())
        for before, after in [(None, (1, {})), ((1, {}), None), ((1, {}), (1, {}))]:
            self.assertEqual(probe.network_usage(before, after), {'status': 'unavailable', 'interfaces': []})


class NvmlProcessTests(unittest.TestCase):
    def library(self, read):
        return Mock(nvmlInit_v2=Mock(return_value=0),
                    nvmlDeviceGetHandleByUUID=Mock(return_value=0),
                    nvmlDeviceGetProcessUtilization=Mock(side_effect=read))

    def test_empty_buffer_is_read_before_classifying_activity(self):
        def read(handle, samples, count, since):
            if samples is None:
                count._obj.value = 72
                return 7
            return 6
        library = self.library(read)
        with patch.object(probe.ctypes, 'CDLL', return_value=library):
            result = probe.nvml_process_utilization([{'uuid': 'GPU-one'}], 100)
        self.assertEqual(result, {'GPU-one': {'status': 'no_activity', 'samples': {}}})
        self.assertEqual(library.nvmlDeviceGetProcessUtilization.call_count, 2)
        library.nvmlShutdown.assert_called_once()

    def test_unsupported_and_failed_queries_never_become_zero(self):
        for code, expected in [(3, {'GPU-one': {'status': 'unsupported', 'samples': {}}}), (4, {}), (999, {})]:
            with self.subTest(code=code), patch.object(probe.ctypes, 'CDLL', return_value=self.library(lambda *args: code)):
                self.assertEqual(probe.nvml_process_utilization([{'uuid': 'GPU-one'}], 100), expected)
        with patch.object(probe.ctypes, 'CDLL', side_effect=OSError):
            self.assertEqual(probe.nvml_process_utilization([{'uuid': 'GPU-one'}], 100), {})

    def test_latest_valid_nvml_samples_and_buffer_growth(self):
        calls = 0
        def read(handle, samples, count, since):
            nonlocal calls
            calls += 1
            if calls < 3:
                count._obj.value = 1 if calls == 1 else 4
                return 7
            for sample, values in zip(samples, [(101, 101, 80), (101, 102, 90), (102, 99, 40), (103, 101, 999)]):
                sample.pid, sample.timeStamp, sample.smUtil = values
            count._obj.value = 4
            return 0
        with patch.object(probe.ctypes, 'CDLL', return_value=self.library(read)):
            result = probe.nvml_process_utilization([{'uuid': 'GPU-one'}], 100)
        self.assertEqual(result, {'GPU-one': {'status': 'ok', 'samples': {101: 90}}})


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
