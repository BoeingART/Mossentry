"""Fixed agentless Linux operations sent through SSH; no remote installation."""
from __future__ import annotations

import grp
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys


def command(args, *, input=None, allowed=(0,)):
    result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=90)
    if result.returncode not in allowed:
        # Do not return argv: account creation may contain a password hash.
        raise RuntimeError(result.stderr.strip() or f'{args[0]} failed ({result.returncode})')
    return result


def account(name):
    try:
        return pwd.getpwnam(name)
    except KeyError:
        return None


def validate_target(payload, creating=False):
    name = payload.get('managed_username', '')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', name):
        raise ValueError('Invalid username')
    target = account(name)
    if name not in {'srvmgr', 'sync'}:
        if name in {'root', 'nobody', payload['ssh_user']} or (target and target.pw_uid < 1000):
            raise ValueError('Protected system or management account')
    if creating and target:
        raise ValueError('Account already exists')
    if not creating and target is None:
        raise ValueError('Account does not exist')
    if os.geteuid() != 0:
        raise RuntimeError('Sudo privileges are required')
    return name, target


def sudo_group():
    for name in ('sudo', 'wheel'):
        try:
            grp.getgrnam(name)
            return name
        except KeyError:
            continue
    raise RuntimeError('No sudo or wheel group exists')


def change_sudo(name, enabled):
    group = sudo_group()
    if enabled:
        command(['usermod', '-a', '-G', group, name])
    elif name in grp.getgrnam(group).gr_mem:
        command(['gpasswd', '-d', name, group])
    result = command(['sudo', '-n', '-l', '-U', name, '/bin/sh'], allowed=(0, 1))
    if (result.returncode == 0) != enabled:
        raise RuntimeError('The resulting sudo privileges do not match the approved request')


def run(payload):
    operation = payload['operation']
    if operation == 'test_connection':
        return {'ping': 'pong', 'platform': sys.platform}
    if not sys.platform.startswith('linux'):
        raise RuntimeError('Account management and status currently require a Linux server')
    if operation == 'server_status':
        return {'uptime': Path('/proc/uptime').read_text(), 'load': Path('/proc/loadavg').read_text(),
                'memory': Path('/proc/meminfo').read_text(), 'disk': command(['df', '-Pk', '/']).stdout}
    if operation == 'scan_users':
        if os.geteuid() != 0:
            raise RuntimeError('Sudo privileges are required to scan account permissions')
        passwd = command(['getent', 'passwd']).stdout
        administrative = []
        for line in passwd.splitlines():
            name = line.split(':')[0]
            if command(['sudo', '-n', '-l', '-U', name, '/bin/sh'], allowed=(0, 1)).returncode == 0:
                administrative.append(name)
        creation = command([sys.executable, '-c', payload['creation_source']], input=passwd, allowed=(0, 1))
        return {'passwd': passwd, 'sudo': command(['getent', 'group', 'sudo'], allowed=(0, 2)).stdout,
                'wheel': command(['getent', 'group', 'wheel'], allowed=(0, 2)).stdout,
                'effective_sudo': '\n'.join(administrative),
                'creation_times': json.loads(creation.stdout) if creation.returncode == 0 else {}}
    creating = operation == 'create_user' or (operation == 'preflight' and payload.get('managed_create'))
    name, target = validate_target(payload, creating=creating)
    if operation == 'preflight':
        for tool in ('useradd', 'usermod', 'getent'):
            if not shutil.which(tool):
                raise RuntimeError(f'Required account tool is missing: {tool}')
    elif operation == 'create_user':
        command(['useradd', '-m', '-U', '-s', '/bin/bash', '-c', payload.get('managed_comment', ''),
                 '-p', payload['managed_password_hash'], name])
        target = pwd.getpwnam(name)
        home = Path(target.pw_dir)
        ssh = home / '.ssh'
        if ssh.is_symlink():
            raise RuntimeError('Refusing to write to a symlinked SSH directory')
        ssh.mkdir(mode=0o700, exist_ok=True)
        ssh.chmod(0o700)
        os.chown(ssh, target.pw_uid, target.pw_gid)
        authorized = ssh / 'authorized_keys'
        descriptor = os.open(authorized, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'a') as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.fchown(stream.fileno(), target.pw_uid, target.pw_gid)
            stream.write(payload['managed_public_key'] + '\n')
        if payload.get('managed_sudo'):
            change_sudo(name, True)
    elif operation == 'disable_user':
        command(['usermod', '-L', '-s', '/usr/sbin/nologin', name])
    elif operation == 'enable_user':
        shadow = command(['getent', 'shadow', name]).stdout.split(':')[1]
        command(['usermod', '-s', '/bin/bash', name])
        if shadow.startswith('!') and len(shadow) > 2:
            command(['usermod', '-U', name])
    elif operation == 'set_sudo':
        change_sudo(name, bool(payload['managed_sudo']))
    elif operation == 'delete_user':
        command(['userdel', name])  # no --remove, no --force
    else:
        raise ValueError('Unknown operation')
    return {'ok': True}


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.loads(sys.stdin.readline()))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
