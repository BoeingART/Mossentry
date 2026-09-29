"""Read-only Linux probe, sent over SSH stdin. Remote dependencies: Python 3 only."""
import csv
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


def disks():
    result, seen, unavailable = [], set(), []
    for line in Path('/proc/self/mounts').read_text().splitlines():
        fields = line.split()
        source, mount, kind = map(unescape_mount, fields[:3])
        if mount != '/' and not (source.startswith('/dev/') or kind in {'nfs', 'nfs4', 'cifs', 'ceph', 'lustre', 'zfs'}):
            continue
        try:
            # Avoid repeating bind mounts while retaining separate filesystems.
            device = os.stat(mount).st_dev
            if device in seen:
                continue
            stat = os.statvfs(mount)
            if not stat.f_blocks:
                continue
            seen.add(device)
            used = stat.f_blocks - stat.f_bfree
            available = stat.f_bavail
            result.append({'mount': mount, 'filesystem': kind,
                           'total_gb': round(stat.f_blocks * stat.f_frsize / 1024 ** 3, 1),
                           'used_gb': round(used * stat.f_frsize / 1024 ** 3, 1),
                           'percent': round(100 * used / max(used + available, 1), 1)})
        except OSError:
            unavailable.append(mount)
    return sorted(result, key=lambda item: (item['mount'] != '/', item['mount'])), unavailable


def smi(*args):
    result = subprocess.run(['nvidia-smi', *args], capture_output=True, text=True, timeout=6,
                            env={**os.environ, 'LC_ALL': 'C'}, check=False)
    if result.returncode:
        raise RuntimeError('NVIDIA metrics unavailable')
    return result.stdout


def csv_rows(output):
    return csv.reader(io.StringIO(output), skipinitialspace=True)


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
                            'process_utilization_available': False})
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
                processes[key] = {'pid': pid, 'username': owner, 'sm_percent': None, 'memory_mb': None}
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
        try:
            # pmon SM is per-process utilization; framebuffer usage is a separate metric.
            output = smi('pmon', '-c', '1', '-s', 'u')
            for line in output.splitlines():
                fields = line.split()
                if len(fields) < 5 or not fields[0].isdigit():
                    continue
                device = by_index.get(int(fields[0]))
                if device is None or not fields[1].isdigit():
                    continue
                value = number(fields[3])
                process(device, int(fields[1]))['sm_percent'] = value
                if value is not None:
                    device['process_utilization_available'] = True
        except (RuntimeError, OSError, subprocess.TimeoutExpired):
            pass
        return {'status': 'ok', 'message': '' if devices else 'No NVIDIA GPUs detected.', 'devices': devices}
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError):
        return {'status': 'error', 'message': 'NVIDIA metrics could not be read. Check the driver and device permissions.', 'devices': []}


def collect():
    before = cpu_snapshot()
    time.sleep(1)
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
    filesystems, unavailable = disks()
    if unavailable:
        warnings.append('Some mounted filesystems could not be read: ' + ', '.join(unavailable))
    gpu = gpu_usage()
    if any(p['username'] is None for d in gpu['devices'] for p in d['processes']):
        warnings.append('Some GPU process owners are unavailable and cannot be included in a user filter.')
    return {'checked_at': datetime.now(timezone.utc).isoformat(), 'cpu': cpu,
            'memory': {'total_mb': round(total / 1024), 'used_mb': round(used / 1024), 'percent': round(100 * used / max(total, 1), 1)},
            'disks': filesystems, 'gpu': gpu, 'warnings': warnings}


if __name__ == '__main__':
    print(json.dumps(collect(), allow_nan=False))
