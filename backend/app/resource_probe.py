"""Read-only Linux probe, sent over SSH stdin. Remote dependencies: Python 3 only."""
import csv
import ctypes
import io
import json
import math
import os
import pwd
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError):
        return None


def username(uid):
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def process_owner(pid):
    # /proc/PID's directory owner can become root for non-dumpable processes.
    # Use the effective UID from status, matching ps's USER column.
    for line in Path('/proc', str(pid), 'status').read_text().splitlines():
        if line.startswith('Uid:'):
            return int(line.split()[2])
    raise ValueError('Process UID unavailable')


def cpu_snapshot():
    lines = Path('/proc/stat').read_text().splitlines()
    # guest and guest_nice are already included in user and nice.
    ticks = [int(value) for value in lines[0].split()[1:9]]
    cores = sum(bool(re.match(r'^cpu\d+\s', line)) for line in lines)
    processes, restricted = {}, False
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            uid = process_owner(entry.name)
            # PID + start time prevents attributing a reused PID to its old owner.
            processes[(int(entry.name), int(fields[19]))] = (uid, int(fields[11]) + int(fields[12]))
        except PermissionError:
            restricted = True
        except (OSError, ValueError, IndexError):
            continue  # Process exited during collection.
    return sum(ticks), ticks[3] + ticks[4], max(cores, 1), processes, restricted


def cpu_usage(before, after):
    total = max(after[0] - before[0], 1)
    users = {}
    for identity, (uid, ticks) in after[3].items():
        item = users.setdefault(uid, {'username': username(uid), 'cpu_percent': 0.0, 'processes': 0})
        item['processes'] += 1
        previous = before[3].get(identity)
        if previous and previous[0] == uid:
            item['cpu_percent'] += max(0, ticks - previous[1]) / total * 100
    return {
        'percent': round(min(100, max(0, (1 - (after[1] - before[1]) / total) * 100)), 1),
        'cores': after[2],
        'users': sorted([{**item, 'cpu_percent': round(item['cpu_percent'], 2)} for item in users.values()],
                        key=lambda item: (-item['cpu_percent'], item['username'])),
        'restricted': before[4] or after[4],
    }


def unescape_mount(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)


def read_optional(path):
    try:
        return path.read_text().strip()
    except OSError:
        return ''


def network_snapshot(proc=Path('/proc/net/dev'), root=Path('/sys/class/net')):
    try:
        content = proc.read_text()
        sampled_at = time.monotonic()
    except OSError:
        return None
    interfaces = {}
    for line in content.splitlines():
        if ':' not in line:
            continue
        name, values = line.rsplit(':', 1)
        name, fields = name.strip(), values.split()
        if name == 'lo' or len(fields) < 16:
            continue
        try:
            received, sent = int(fields[0]), int(fields[8])
            identity = int((root / name / 'ifindex').read_text())
            if min(received, sent) < 0:
                continue
        except (OSError, ValueError):
            continue
        interfaces[name] = {'identity': identity, 'rx': received, 'tx': sent,
                            'physical': (root / name / 'device').exists(),
                            'up': read_optional(root / name / 'operstate') == 'up'}
    return sampled_at, interfaces


def network_usage(before, after):
    if before is None or after is None or after[0] <= before[0]:
        return {'status': 'unavailable', 'interfaces': []}
    elapsed = after[0] - before[0]
    interfaces = []
    # Prefer an active hardware interface; expose each interface separately so
    # bridges, bonds and their members cannot double-count a server-wide total.
    ordered = sorted(after[1].items(), key=lambda pair: (not pair[1]['up'], not pair[1]['physical'], pair[0]))
    for name, current in ordered:
        previous = before[1].get(name)
        valid = previous and previous['identity'] == current['identity']
        def rate(direction):
            if not valid or current[direction] < previous[direction]:
                return None  # Interface replacement or counter reset.
            return round((current[direction] - previous[direction]) / elapsed, 2)
        interfaces.append({'name': name, 'rx_bytes_per_second': rate('rx'), 'tx_bytes_per_second': rate('tx')})
    return {'status': 'ok', 'interfaces': interfaces}


def block_topology(root=Path('/sys/class/block')):
    """Resolve partitions and stacked devices to server-visible hardware disks."""
    nodes, physical = {}, {}
    for entry in root.iterdir():
        identity = read_optional(entry / 'dev')
        if not identity:
            continue
        resolved = entry.resolve()
        partition = (entry / 'partition').exists()
        parents = [resolved.parent.name] if partition else [item.name for item in (entry / 'slaves').iterdir()]
        nodes[entry.name] = {'identity': identity, 'parents': parents}
        # Never promote device-mapper, md, loop, zram or optical devices to disks.
        if partition or parents or 'virtual' in resolved.parts or re.match(r'^(loop|ram|zram|sr|fd)\d', entry.name):
            continue
        if not (entry / 'device').exists():
            continue
        device_type = read_optional(entry / 'device/type')
        if device_type and device_type != '0':
            continue
        sectors = number(read_optional(entry / 'size'))
        if sectors is None or sectors == 0:
            continue
        physical[entry.name] = {
            'name': '/dev/' + entry.name,
            'model': read_optional(entry / 'device/model'),
            'size_bytes': int(sectors) * 512,
        }

    def backing(name, visited):
        if name in visited or name not in nodes:
            return set(), False
        if name in physical:
            return {name}, True
        parents = nodes[name]['parents']
        if not parents:
            return set(), False
        owners, complete = set(), True
        for parent in parents:
            found, valid = backing(parent, visited | {name})
            owners.update(found)
            complete = complete and valid
        return owners, complete

    mapping = {}
    for name, node in nodes.items():
        owners, complete = backing(name, set())
        if complete and owners:
            mapping[node['identity']] = owners
    return physical, mapping


def group_disk_usage(physical, filesystems):
    # A filesystem spanning several disks is counted once, in one disk group.
    # Union overlapping groups so no physical disk occurs in multiple bars.
    parents = {name: name for name in physical}

    def find(name):
        while parents[name] != name:
            name = parents[name]
        return name

    for filesystem in filesystems:
        owners = sorted(filesystem['owners'])
        for owner in owners[1:]:
            parents[find(owner)] = find(owners[0])
    groups = {}
    for name in sorted(physical):
        groups.setdefault(find(name), {'names': [], 'filesystems': []})['names'].append(name)
    for filesystem in filesystems:
        groups[find(next(iter(filesystem['owners'])))]['filesystems'].append(filesystem)
    result = []
    for group in groups.values():
        names, mounted = group['names'], group['filesystems']
        measured = [item for item in mounted if item['usage'] is not None]
        total = sum(item['usage']['total'] for item in measured)
        used = sum(item['usage']['used'] for item in measured)
        available = sum(item['usage']['available'] for item in measured)
        complete = bool(mounted) and len(measured) == len(mounted)
        devices = [{'name': physical[name]['name'], 'model': physical[name]['model'],
                    'total_gb': round(physical[name]['size_bytes'] / 1024 ** 3, 1)} for name in names]
        result.append({
            'id': '+'.join(names), 'devices': devices, 'shared': len(names) > 1,
            'total_gb': round(sum(physical[name]['size_bytes'] for name in names) / 1024 ** 3, 1),
            'filesystem_total_gb': round(total / 1024 ** 3, 1) if complete else None,
            'used_gb': round(used / 1024 ** 3, 1) if complete else None,
            'percent': round(100 * used / max(used + available, 1), 1) if complete else None,
            'mounts': sorted(mount for item in mounted for mount in item['mounts']),
            'status': 'ok' if complete else 'unavailable' if mounted else 'unmounted',
        })
    return sorted(result, key=lambda item: item['id'])


def disks():
    try:
        physical, mapping = block_topology()
    except (OSError, ValueError):
        return [], ['Physical disk topology could not be read. Disk usage is unavailable.']
    filesystems, warnings = {}, []
    for line in Path('/proc/self/mounts').read_text().splitlines():
        fields = line.split()
        if len(fields) < 3:
            continue
        source, mount, kind = map(unescape_mount, fields[:3])
        # Network filesystems, tmpfs and container overlays are not local disks.
        if not source.startswith('/dev/') and mount != '/':
            continue
        if kind in {'overlay', 'tmpfs', 'devtmpfs', 'nfs', 'nfs4', 'cifs', 'ceph', 'lustre', 'zfs'}:
            continue
        try:
            device = os.stat(mount).st_dev
            identity = '%s:%s' % (os.major(device), os.minor(device))
            if identity not in mapping:
                # Some filesystems expose a synthetic st_dev. Resolve their source.
                device = os.stat(source).st_rdev
                identity = '%s:%s' % (os.major(device), os.minor(device))
            owners = mapping.get(identity)
            if not owners:
                continue
            if kind == 'btrfs':
                # A btrfs source names only one member, not the complete pool.
                warnings.append('Btrfs pool usage is omitted because its full physical disk mapping is unavailable.')
                continue
            if identity in filesystems:
                filesystems[identity]['mounts'].append(mount)
                continue
            item = {'owners': owners, 'mounts': [mount], 'usage': None}
            filesystems[identity] = item
            try:
                stat = os.statvfs(mount)
                if stat.f_blocks:
                    item['usage'] = {'total': stat.f_blocks * stat.f_frsize,
                                     'used': (stat.f_blocks - stat.f_bfree) * stat.f_frsize,
                                     'available': stat.f_bavail * stat.f_frsize}
            except OSError:
                warnings.append('Filesystem usage could not be read: ' + mount)
        except OSError:
            warnings.append('Physical disk mapping could not be read for: ' + mount)
    return group_disk_usage(physical, list(filesystems.values())), list(dict.fromkeys(warnings))


def smi(*args):
    result = subprocess.run(['nvidia-smi', *args], capture_output=True, text=True, timeout=6,
                            env={**os.environ, 'LC_ALL': 'C'}, check=False)
    if result.returncode:
        raise RuntimeError('NVIDIA metrics unavailable')
    return result.stdout


def csv_rows(output):
    return csv.reader(io.StringIO(output), skipinitialspace=True)


def nvml_process_utilization(devices, since_us):
    """Distinguish an empty activity window from an unsupported query.

    NVML records processes with non-zero activity. NOT_FOUND (6) means the
    supported query has no activity samples, unlike NOT_SUPPORTED (3).
    Use the driver library already installed on the host, without Python extras.
    """
    class UtilizationSample(ctypes.Structure):
        _fields_ = [('pid', ctypes.c_uint), ('timeStamp', ctypes.c_ulonglong),
                    ('smUtil', ctypes.c_uint), ('memUtil', ctypes.c_uint),
                    ('encUtil', ctypes.c_uint), ('decUtil', ctypes.c_uint)]

    results = {}
    initialized = False
    try:
        library = ctypes.CDLL('libnvidia-ml.so.1')
        if library.nvmlInit_v2() != 0:
            return results
        initialized = True
        get_handle = library.nvmlDeviceGetHandleByUUID
        get_handle.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        get_samples = library.nvmlDeviceGetProcessUtilization
        get_samples.argtypes = [ctypes.c_void_p, ctypes.POINTER(UtilizationSample),
                                ctypes.POINTER(ctypes.c_uint), ctypes.c_ulonglong]
        for device in devices:
            handle = ctypes.c_void_p()
            if get_handle(device['uuid'].encode(), ctypes.byref(handle)) != 0:
                continue
            count = ctypes.c_uint(0)
            code = get_samples(handle, None, ctypes.byref(count), since_us)
            samples = None
            # Process counts may grow between sizing and reading; bound retries.
            for _ in range(3):
                if code != 7 or count.value > 100000:
                    break
                samples = (UtilizationSample * max(1, count.value))()
                code = get_samples(handle, samples, ctypes.byref(count), since_us)
            if code == 3:
                results[device['uuid']] = {'status': 'unsupported', 'samples': {}}
            elif code == 6 or code == 0:
                latest = {}
                for sample in list(samples or [])[:count.value] if code == 0 else []:
                    if sample.timeStamp <= since_us or sample.smUtil > 100:
                        continue
                    previous = latest.get(sample.pid)
                    if previous is None or sample.timeStamp > previous['timestamp']:
                        latest[sample.pid] = {'timestamp': sample.timeStamp, 'percent': sample.smUtil}
                results[device['uuid']] = {'status': 'ok' if latest else 'no_activity',
                                          'samples': {pid: sample['percent'] for pid, sample in latest.items()}}
    except (OSError, AttributeError, ValueError):
        pass
    finally:
        if initialized:
            library.nvmlShutdown()
    return results


def parse_pmon(output):
    """Read named columns; driver versions add JPEG/OFA/CCPM columns."""
    columns = {}
    result = {}
    for line in output.splitlines():
        fields = line.split()
        if fields[:2] == ['#', 'gpu'] and 'pid' in fields:
            columns = {name: index for index, name in enumerate(fields[1:])}
            continue
        if not columns or not fields or not fields[0].isdigit():
            continue

        def field(name):
            index = columns.get(name)
            return fields[index] if index is not None and index < len(fields) else ''

        if not field('pid').isdigit():
            continue
        # Keep the final cycle, including '-' replacing an earlier numeric value.
        result[(int(field('gpu')), int(field('pid')))] = {
            'sm_percent': number(field('sm')), 'memory_mb': number(field('fb')),
            'kind': field('type'), 'name': field('command'),
        }
    return result


def gpu_usage():
    if not shutil.which('nvidia-smi'):
        return {'status': 'unavailable', 'message': 'NVIDIA monitoring requires nvidia-smi. No supported driver was found.', 'devices': []}
    try:
        output = smi('--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits')
        devices = []
        for fields in csv_rows(output):
            if len(fields) != 7:
                continue
            index, uuid, name, utilization, used, total, temperature = fields
            devices.append({'index': int(index), 'uuid': uuid, 'name': name, 'percent': number(utilization),
                            'memory_used_mb': number(used), 'memory_total_mb': number(total),
                            'temperature': number(temperature), 'processes': [], 'process_memory_available': False,
                            'process_utilization_available': False, 'process_utilization_status': 'unavailable'})
        by_uuid = {item['uuid']: item for item in devices}
        by_index = {item['index']: item for item in devices}
        processes = {}

        def process(device, pid):
            key = (device['uuid'], pid)
            if key not in processes:
                try:
                    owner = username(process_owner(pid))
                except (OSError, ValueError):
                    owner = None
                processes[key] = {'pid': pid, 'username': owner, 'sm_percent': None, 'memory_mb': None,
                                  'kind': 'C', 'name': '', 'sm_source': 'unavailable'}
                device['processes'].append(processes[key])
            return processes[key]

        try:
            output = smi('--query-compute-apps=gpu_uuid,pid,used_gpu_memory', '--format=csv,noheader,nounits')
            for device in devices:
                device['process_memory_available'] = True
            for fields in csv_rows(output):
                if len(fields) == 3 and fields[0] in by_uuid and fields[1].isdigit():
                    process(by_uuid[fields[0]], int(fields[1]))['memory_mb'] = number(fields[2])
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            pass
        since_us = int(time.time() * 1000000)
        pmon_failed = False
        try:
            # Include framebuffer memory for graphics processes such as Xorg.
            # A second cycle also avoids relying on pmon's initial sample.
            output = smi('pmon', '-c', '2', '-d', '1', '-s', 'um')
            for (index, pid), values in parse_pmon(output).items():
                device = by_index.get(index)
                if device is None:
                    continue
                item = process(device, pid)
                item.update({key: values[key] for key in ('kind', 'name', 'sm_percent')})
                if values['memory_mb'] is not None:
                    item['memory_mb'] = values['memory_mb']
                if values['sm_percent'] is not None:
                    item['sm_source'] = 'pmon'
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            pmon_failed = True
        nvml = nvml_process_utilization(devices, since_us)
        for device in devices:
            activity = nvml.get(device['uuid'], {})
            supported = activity.get('status') in {'ok', 'no_activity'}
            for item in device['processes']:
                if item['sm_percent'] is None and supported:
                    measured = activity['samples'].get(item['pid'])
                    item['sm_percent'] = measured if measured is not None else 0
                    item['sm_source'] = 'nvml' if measured is not None else 'no_activity'
            device['process_utilization_available'] = supported or any(item['sm_percent'] is not None for item in device['processes'])
            device['process_utilization_status'] = (
                'ok' if any(item['sm_percent'] for item in device['processes']) else
                'no_activity' if supported else
                'ok' if device['process_utilization_available'] else
                'unsupported' if activity.get('status') == 'unsupported' else
                'error' if pmon_failed else 'unavailable'
            )
            device['process_memory_available'] = device['process_memory_available'] or any(item['memory_mb'] is not None for item in device['processes'])
        return {'status': 'ok', 'message': '' if devices else 'No NVIDIA GPUs detected.', 'devices': devices}
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError):
        return {'status': 'error', 'message': 'NVIDIA metrics could not be read. Check the driver and device permissions.', 'devices': []}


def collect():
    before = cpu_snapshot()
    network_before = network_snapshot()
    time.sleep(1)
    network = network_usage(network_before, network_snapshot())
    after = cpu_snapshot()
    cpu = cpu_usage(before, after)
    warnings = []
    mounts = Path('/proc/self/mounts').read_text()
    if cpu.pop('restricted') or re.search(r'hidepid=(?:[12]|invisible|noaccess)\b', mounts):
        warnings.append('Process visibility is restricted. CPU/GPU user totals may be incomplete.')
    warnings.append('User CPU samples include processes visible at both ends of the sample; short-lived processes may be omitted.')
    memory = {line.split(':')[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}
    total = memory['MemTotal']
    available = memory.get('MemAvailable')
    if available is None:
        available = memory.get('MemFree', 0) + memory.get('Buffers', 0) + memory.get('Cached', 0)
        warnings.append('Memory availability is estimated on this kernel.')
    used = max(0, total - available)
    disk_groups, disk_warnings = disks()
    warnings.extend(disk_warnings)
    gpu = gpu_usage()
    if any(p['username'] is None for d in gpu['devices'] for p in d['processes']):
        warnings.append('Some GPU process owners are unavailable and cannot be included in a user filter.')
    return {'checked_at': datetime.now(timezone.utc).isoformat(), 'cpu': cpu,
            'memory': {'total_mb': round(total / 1024), 'used_mb': round(used / 1024), 'percent': round(100 * used / max(total, 1), 1)},
            'disks': disk_groups, 'gpu': gpu, 'network': network, 'warnings': warnings}


if __name__ == '__main__':
    print(json.dumps(collect(), allow_nan=False))
