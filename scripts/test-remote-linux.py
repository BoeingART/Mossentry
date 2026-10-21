"""Run only inside the disposable CI container, never on a managed host."""
import crypt
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys

assert Path('/.dockerenv').exists(), 'This test requires an isolated Docker container'
assert os.geteuid() == 0
sys.path.insert(0, '/source/src-tauri/remote')
from remote_actions import run

name = 'mossentry_release_fixture'
base = {'managed_username': name, 'ssh_user': 'root'}
run({**base, 'operation': 'preflight', 'managed_create': True})
run({**base, 'operation': 'create_user', 'managed_comment': 'Release test', 'managed_sudo': False,
     'managed_password_hash': crypt.crypt('temporary-fixture-password', crypt.mksalt(crypt.METHOD_SHA512)),
     'managed_public_key': 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID7wZ2OGEFlDEoROCF2xpk+6EpfALNX/uNhHwPNxbl8Q fixture'})
home = Path(pwd.getpwnam(name).pw_dir)
assert (home / '.ssh/authorized_keys').stat().st_mode & 0o777 == 0o600
run({**base, 'operation': 'disable_user'})
assert pwd.getpwnam(name).pw_shell.endswith('nologin')
run({**base, 'operation': 'enable_user'})
assert pwd.getpwnam(name).pw_shell == '/bin/bash'
assert not subprocess.check_output(['getent', 'shadow', name], text=True).split(':')[1].startswith('!')
run({**base, 'operation': 'set_sudo', 'managed_sudo': True})
run({**base, 'operation': 'set_sudo', 'managed_sudo': False})
scan = run({'operation': 'scan_users', 'creation_source': Path('/source/src-tauri/remote/user_creation_times.py').read_text()})
assert name + ':' in scan['passwd']
status = run({'operation': 'server_status'})
assert 'MemTotal' in status['memory']
run({**base, 'operation': 'delete_user'})
assert home.is_dir(), 'Deleting an account must retain its home and files'
try:
    pwd.getpwnam(name)
    raise AssertionError('Account still exists')
except KeyError:
    pass
print('Native Linux account create/scan/disable/enable/sudo/delete and file preservation passed.')

# Read-only operations must work with the container's existing Python. No
# systemd/journal packages or resident agents are installed for these checks.
from operations_probe import run as maintenance
inspection = maintenance({'operation': 'inspect'})
assert inspection['os'] and inspection['cores'] > 0
assert isinstance(inspection['filesystems'], list)
assert isinstance(inspection['alerts'], list)
service_list = maintenance({'operation': 'services'})
assert isinstance(service_list['available'], bool)
journal = maintenance({'operation': 'logs', 'lines': 5, 'minutes': 5, 'priority': 6})
assert isinstance(journal['available'], bool)
assert len(journal['entries']) <= 5
print('Agentless inspection and optional systemd/journal capability detection passed.')
