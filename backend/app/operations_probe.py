"""Fixed Linux operations, using only Python stdlib and existing system utilities.

Executed in memory over SSH or by the fixed Ansible playbook. Never installs
software, changes unit definitions, or accepts shell commands from the client.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import selectors
import time

UNIT = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,191}\.service')
MUTATIONS = {'start', 'stop', 'restart', 'enable', 'disable'}
PROTECTED = {'ssh', 'sshd', 'network', 'networking', 'networkmanager', 'dbus',
             'systemd-networkd', 'systemd-resolved', 'systemd-logind',
             'systemd-journald', 'systemd-udevd', 'firewalld', 'ufw'}


def protected_unit(unit):
    return (unit[:-8] if unit.endswith('.service') else unit).split('@')[0].lower() in PROTECTED


def command(argv, allowed=(0,), timeout=20):
    # Drain both pipes with bounded buffers. Large journal entries must not fill
    # memory or the remote temporary filesystem. No shell, pager or disk spool.
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    limits = {'stdout': 2 * 1024 * 1024, 'stderr': 4096}
    truncated = False
    deadline = time.monotonic() + timeout
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env={**os.environ, 'LC_ALL': 'C', 'SYSTEMD_PAGER': '', 'SYSTEMD_COLORS': '0'}) as process:
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
                selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    for key, _ in selector.select(min(remaining, 1)):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        available = limits[key.data] - len(buffers[key.data])
                        buffers[key.data].extend(chunk[:available])
                        truncated |= len(chunk) > available
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except BaseException:
            process.kill()
            process.wait()
            raise
    text = buffers['stdout'].decode('utf-8', errors='replace')
    warning = buffers['stderr'].decode('utf-8', errors='replace').strip()
    if code not in allowed:
        raise RuntimeError(warning or f'{argv[0]} failed ({code})')
    if truncated:
        text = text.rsplit('\n', 1)[0]
        warning = (warning + '\nOutput truncated to the capture limit.').strip()
    return text, warning


def has_systemd():
    return bool(shutil.which('systemctl') and Path('/run/systemd/system').is_dir())


def services():
    if not has_systemd():
        return {'available': False, 'services': [], 'warnings': ['systemd is not available on this host.']}
    installed, warning1 = command(['systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager'])
    loaded, warning2 = command(['systemctl', 'list-units', '--all', '--type=service', '--no-legend', '--no-pager', '--plain'])
    units = {}
    for line in installed.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            units[parts[0]] = {'unit': parts[0], 'enabled': parts[1], 'active': 'inactive', 'sub': '', 'description': ''}
    for line in loaded.splitlines():
        parts = line.split(None, 4)
        if len(parts) >= 4:
            unit, load, active, sub = parts[:4]
            units.setdefault(unit, {'unit': unit, 'enabled': 'unknown'})
            units[unit].update(active=active, sub=sub, description=parts[4] if len(parts) == 5 else '', load=load)
    result = sorted(units.values(), key=lambda item: (item['active'] != 'failed', item['unit']))
    for item in result:
        item['protected'] = protected_unit(item['unit'])
    warnings = [warning for warning in (warning1, warning2) if warning]
    if len(result) > 2000:
        warnings.append('Service list truncated to 2000 units.')
    return {'available': True, 'services': result[:2000], 'warnings': warnings}


def inspect():
    warnings = []
    os_release = {}
    try:
        for line in Path('/etc/os-release').read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep:
                os_release[key] = value.strip('"\'')
    except OSError:
        warnings.append('Operating system release is unavailable.')
    memory = {}
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            key, value = line.split(':', 1)
            memory[key] = int(value.split()[0])
    except (OSError, ValueError):
        warnings.append('Memory information is unavailable.')
    total, available = memory.get('MemTotal'), memory.get('MemAvailable')
    memory_percent = round((total - available) / total * 100, 1) if total and available is not None else None
    swap_total, swap_free = memory.get('SwapTotal'), memory.get('SwapFree')
    swap_percent = round((swap_total - swap_free) / swap_total * 100, 1) if swap_total and swap_free is not None else None
    filesystems, seen = [], set()
    try:
        mounts = Path('/proc/self/mounts').read_text().splitlines()
    except OSError:
        mounts = []
        warnings.append('Filesystem information is unavailable.')
    # Limit to local writable data filesystems. Avoid hanging on remote mounts.
    for line in mounts:
        fields = line.split()
        if len(fields) < 4 or fields[2] not in {'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'vfat', 'f2fs', 'overlay'}:
            continue
        mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[1])
        try:
            identity = os.stat(mount).st_dev
            if identity in seen:
                continue
            stat = os.statvfs(mount)
            seen.add(identity)
            used = stat.f_blocks - stat.f_bfree
            percent = round(100 * used / (used + stat.f_bavail), 1) if used + stat.f_bavail else None
            inode = round(100 * (stat.f_files - stat.f_ffree) / stat.f_files, 1) if stat.f_files else None
            filesystems.append({'mount': mount, 'type': fields[2], 'percent': percent, 'inode_percent': inode,
                                'available_gb': round(stat.f_bavail * stat.f_frsize / 1024 ** 3, 2)})
        except OSError:
            warnings.append('Cannot read filesystem: ' + mount)
    cores = os.cpu_count() or 1
    load = list(os.getloadavg())
    try:
        uptime = int(float(Path('/proc/uptime').read_text().split()[0]))
    except (OSError, ValueError):
        uptime = None
    failed = None
    if has_systemd():
        try:
            text, warning = command(['systemctl', '--failed', '--type=service', '--no-legend', '--no-pager', '--plain'])
            failed = [line.split()[0] for line in text.splitlines() if line.strip()]
            if warning:
                warnings.append(warning)
        except (RuntimeError, subprocess.TimeoutExpired):
            warnings.append('Failed service information is unavailable.')
    alerts = []
    if memory_percent is not None and memory_percent >= 90:
        alerts.append({'kind': 'memory', 'target': '', 'value': memory_percent})
    if load[1] > cores:
        alerts.append({'kind': 'load', 'target': '', 'value': round(load[1] / cores, 2)})
    for disk in filesystems:
        for key, kind in [('percent', 'disk'), ('inode_percent', 'inode')]:
            if disk[key] is not None and disk[key] >= 90:
                alerts.append({'kind': kind, 'target': disk['mount'], 'value': disk[key]})
    for unit in failed or []:
        alerts.append({'kind': 'service', 'target': unit, 'value': None})
    return {'hostname': platform.node(), 'os': os_release.get('PRETTY_NAME', platform.system()),
            'kernel': platform.release(), 'architecture': platform.machine(), 'cores': cores,
            'uptime_seconds': uptime, 'load': load, 'memory_percent': memory_percent,
            'swap_percent': swap_percent, 'filesystems': filesystems, 'failed_services': failed,
            'alerts': alerts, 'warnings': warnings}


def logs(payload):
    if not shutil.which('journalctl'):
        return {'available': False, 'entries': [], 'warnings': ['journalctl is not available on this host.']}
    minutes, lines, priority = payload.get('minutes', 60), payload.get('lines', 100), payload.get('priority', 6)
    if any(type(v) is not int for v in (minutes, lines, priority)) or not (1 <= minutes <= 10080 and 1 <= lines <= 1000 and 0 <= priority <= 7):
        raise ValueError('Invalid log query limits')
    argv = ['journalctl', '--no-pager', '--output=json', '--since', f'-{minutes}min',
            '--lines', str(lines), '--priority', str(priority)]
    if payload.get('unit'):
        argv.extend(['--unit', payload['unit']])
    text, warning = command(argv)
    entries = []
    for line in text.splitlines():
        item = json.loads(line)
        message = item.get('MESSAGE', '')
        if isinstance(message, list):
            message = bytes(message).decode(errors='replace') if all(type(x) is int and 0 <= x <= 255 for x in message) else str(message)
        entries.append({'timestamp': str(item.get('__REALTIME_TIMESTAMP', '')), 'unit': str(item.get('_SYSTEMD_UNIT', '')),
                        'priority': str(item.get('PRIORITY', '')), 'message': str(message)[:8192]})
    return {'available': True, 'entries': entries, 'warnings': [warning] if warning else [],
            'scope': 'system' if os.geteuid() == 0 else 'accessible', 'limit': lines}


def service_change(payload):
    unit, action = payload['unit'], payload['operation']
    if not unit or protected_unit(unit):
        raise ValueError('Protected system or SSH service')
    if not has_systemd():
        raise RuntimeError('systemd is not available on this host')
    if os.geteuid() != 0:
        raise RuntimeError('Sudo privileges are required')
    raw, _ = command(['systemctl', 'show', '--no-pager', '--property=Id,Names,LoadState,RefuseManualStart,RefuseManualStop', '--', unit])
    properties = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    if properties.get('LoadState') != 'loaded':
        raise ValueError('Service is not loaded or is masked')
    names = set(properties.get('Names', '').split()) | {properties.get('Id', unit), unit}
    if any(protected_unit(name) for name in names):
        raise ValueError('Protected system or SSH service')
    if properties.get('RefuseManualStart') == 'yes' and action in {'start', 'restart'}:
        raise ValueError('Service refuses manual start')
    if properties.get('RefuseManualStop') == 'yes' and action in {'stop', 'restart'}:
        raise ValueError('Service refuses manual stop')
    # enable/disable only changes boot policy. It deliberately omits --now.
    _, warning = command(['systemctl', action, '--', unit], timeout=60)
    state, _ = command(['systemctl', 'show', '--no-pager', '--property=Id,ActiveState,SubState,UnitFileState', '--', unit])
    return {'unit': unit, 'operation': action, 'state': dict(line.split('=', 1) for line in state.splitlines() if '=' in line),
            'warnings': [warning] if warning else []}


def run(payload):
    if not sys.platform.startswith('linux'):
        raise RuntimeError('These operations require a Linux server')
    operation, unit = payload.get('operation'), payload.get('unit', '')
    if not isinstance(unit, str) or (unit and not UNIT.fullmatch(unit)):
        raise ValueError('Invalid service name')
    if operation == 'inspect':
        result = inspect()
    elif operation == 'services':
        result = services()
    elif operation == 'logs':
        result = logs(payload)
    elif operation in MUTATIONS:
        result = service_change(payload)
    else:
        raise ValueError('Unknown operation')
    return {**result, 'checked_at': datetime.now(timezone.utc).isoformat()}


if __name__ == '__main__':
    try:
        response = run(json.load(sys.stdin))
    except Exception as error:
        response = {'error': str(error)[:4000], 'checked_at': datetime.now(timezone.utc).isoformat()}
    print(json.dumps(response, ensure_ascii=True))
