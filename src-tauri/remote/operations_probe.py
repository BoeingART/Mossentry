"""Linux command checks/execution and legacy probes over the existing SSH transport."""
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
import shlex
import signal
import time

UNIT = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,191}\.service')
MUTATIONS = {'start', 'stop', 'restart', 'enable', 'disable'}
PROTECTED = {'ssh', 'sshd', 'network', 'networking', 'networkmanager', 'dbus',
             'systemd-networkd', 'systemd-resolved', 'systemd-logind',
             'systemd-journald', 'systemd-udevd', 'firewalld', 'ufw'}

RISK_MESSAGES = {
    'delete': 'Deletion commands may permanently remove files or accounts.',
    'permissions': 'Permission or ownership changes may expose data or lock users out.',
    'privilege': 'Elevated privileges can change system files and affect all users.',
    'packages': 'Package changes may install, remove or upgrade software and restart services.',
    'services': 'Service or process changes may interrupt running workloads or SSH access.',
    'system': 'Shutdown or reboot commands may disconnect the server.',
    'disk': 'Disk or filesystem commands may overwrite data or make storage unavailable.',
    'network': 'Network or firewall changes may disconnect SSH access.',
    'write': 'File writes or redirections may overwrite existing data.',
    'dynamic': 'Dynamic commands, scripts or downloaded code cannot be fully checked before execution.',
}


def command_risks(script, elevated=False, _depth=0):
    """Conservative hints, not a shell sandbox or a guarantee of safety."""
    found = set()
    # Keep operators and command words, including paths, wrappers and quoted
    # shell bodies. False positives are preferable to a claim of safety.
    try:
        lexer = shlex.shlex(script, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        tokens = script.split()
    words = {os.path.basename(word) for word in tokens}
    rules = {
        'delete': {'rm', 'rmdir', 'unlink', 'shred', 'userdel', 'deluser', 'groupdel'},
        'permissions': {'chmod', 'chown', 'chgrp', 'setfacl', 'setcap', 'umask', 'usermod', 'passwd', 'chattr', 'visudo'},
        'privilege': {'sudo', 'su', 'doas'},
        'packages': {'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'rpm', 'pacman', 'zypper', 'apk', 'snap', 'pip', 'pip3'},
        'services': {'systemctl', 'service', 'kill', 'pkill', 'killall'},
        'system': {'reboot', 'shutdown', 'poweroff', 'halt', 'init', 'telinit'},
        'disk': {'dd', 'fdisk', 'sfdisk', 'parted', 'wipefs', 'mount', 'umount', 'mkswap', 'lvremove', 'vgremove', 'pvremove'},
        'network': {'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'ip', 'ifconfig', 'nmcli', 'netplan'},
        'write': {'tee', 'truncate', 'cp', 'mv', 'install', 'touch'},
        'dynamic': {'eval', 'exec', 'source', '.', 'bash', 'sh', 'dash', 'zsh', 'python', 'python3', 'perl', 'ruby', 'node', 'curl', 'wget', 'xargs', 'ssh'},
    }
    for kind, commands in rules.items():
        if words & commands:
            found.add(kind)
    if ('find' in words and '-delete' in tokens) or ('rsync' in words and any(t.startswith('--delete') for t in tokens)):
        found.add('delete')
    if any(word.startswith(('mkfs', 'fsck')) for word in words):
        found.add('disk')
    if any('>' in token for token in tokens) or ('sed' in words and any(t.startswith('-i') for t in tokens)):
        found.add('write')
    if '$' in script or '`' in script or any(word.endswith('.sh') for word in words) or ('find' in words and any(t in tokens for t in ('-exec', '-execdir'))):
        found.add('dynamic')
    if 'dynamic' in found and _depth < 3:
        for token in tokens:
            if any(c.isspace() for c in token):
                nested = command_risks(token, _depth=_depth + 1)
                found.update(kind for kind, message in RISK_MESSAGES.items() if message in nested)
    if elevated:
        found.add('privilege')
    return [message for kind, message in RISK_MESSAGES.items() if kind in found]


def capture_script(script, *, syntax_only, timeout):
    """Feed Bash through a private pipe and give commands an empty stdin."""
    bash = shutil.which('bash')
    if not bash:
        raise RuntimeError('Bash is not available on this host.')
    # In particular, never inherit BASH_ENV, ENV, exported functions or shell
    # options: even a syntax check must not execute a startup file.
    env = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME') if key in os.environ}
    env.update(PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL='C', TERM='dumb')
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    limit = 256 * 1024
    pending = memoryview((script + '\n').encode('utf-8'))
    timed_out = truncated = False
    deadline = time.monotonic() + timeout
    # Keep the script separate from command stdin. Programs such as `cat`, `ssh`
    # or package managers must not consume the following script lines as input.
    read_fd, write_fd = os.pipe()
    script_input = os.fdopen(write_fd, 'wb')
    argv = [bash, '--noprofile', '--norc', *(['-n'] if syntax_only else []), f'/dev/fd/{read_fd}']
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=env, start_new_session=True, pass_fds=(read_fd,))
    except BaseException:
        script_input.close()
        raise
    finally:
        os.close(read_fd)
    with process, script_input:
        def kill_group():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            with selectors.DefaultSelector() as selector:
                for stream, name in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, name)
                os.set_blocking(script_input.fileno(), False)
                selector.register(script_input, selectors.EVENT_WRITE, 'stdin')
                while selector.get_map():
                    if time.monotonic() >= deadline:
                        timed_out = True
                        kill_group()
                        break
                    for key, _ in selector.select(min(0.2, max(0, deadline - time.monotonic()))):
                        if key.data == 'stdin':
                            try:
                                pending = pending[os.write(key.fd, pending[:4096]):]
                            except BrokenPipeError:
                                pending = pending[:0]
                            if not pending:
                                selector.unregister(key.fileobj)
                                script_input.close()
                            continue
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        available = limit - len(buffers[key.data])
                        buffers[key.data].extend(chunk[:available])
                        truncated |= len(chunk) > available
            try:
                code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
                kill_group()
                code = process.wait()
        except BaseException:
            kill_group()
            process.wait()
            raise
    return {name: value.decode('utf-8', errors='replace') for name, value in buffers.items()} | {
        'exit_code': code, 'timed_out': timed_out, 'truncated': truncated,
    }


def shell_operation(payload):
    script = payload.get('command', '')
    timeout = payload.get('timeout', 300)
    if not isinstance(script, str) or not script.strip() or len(script) > 32768 or '\0' in script:
        raise ValueError('Enter a Linux command (up to 32768 characters)')
    if type(timeout) is not int or not 10 <= timeout <= 3600:
        raise ValueError('Invalid command timeout')
    risk_warnings = command_risks(script, payload.get('elevated', False))
    checked = capture_script(script, syntax_only=True, timeout=10)
    syntax_ok = checked['exit_code'] == 0 and not checked['timed_out']
    # Recheck on execution as well. A syntax failure must never run a valid
    # prefix of a malformed multiline script.
    if payload['operation'] == 'dry_run' or not syntax_ok:
        result = checked
    else:
        result = capture_script(script, syntax_only=False, timeout=timeout)
    return {**result, 'syntax_ok': syntax_ok, 'dry_run': payload['operation'] == 'dry_run',
            'risk_warnings': risk_warnings, 'shell': 'bash'}


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
    if operation in {'dry_run', 'command'}:
        result = shell_operation(payload)
    elif operation == 'inspect':
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
