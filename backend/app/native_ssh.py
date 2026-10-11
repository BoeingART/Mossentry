"""Native SSH transport used by packaged clients, including Windows."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import secrets
import time

import paramiko


def framed_program(source, marker):
    # sudo may consume the password, or leave it untouched for NOPASSWD/cached
    # authorization. Discard input through a per-request marker in either case.
    # Execute the source separately so its __future__ imports remain valid.
    return ("import sys\n"
            "for _line in sys.stdin:\n"
            f"    if _line.rstrip('\\r\\n') == {marker!r}:\n"
            "        break\n"
            "else:\n"
            "    raise RuntimeError('Missing SSH request marker')\n"
            f"exec(compile({source!r}, '<mossentry>', 'exec'))\n")


def execute(server, source, payload=None, *, sudo=False, password=None, timeout=30):
    client = paramiko.SSHClient()
    known_hosts = Path.home() / '.ssh' / 'known_hosts'
    if known_hosts.exists():
        client.load_host_keys(str(known_hosts))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    key = Path(server['key_path']).expanduser()
    if os.name != 'nt' and key.stat().st_mode & 0o077:
        raise RuntimeError('The SSH private key must have mode 600')
    try:
        client.connect(server['hostname'], port=int(server['port']), username=server['ssh_user'],
                       key_filename=str(key), allow_agent=False, look_for_keys=False,
                       timeout=10, auth_timeout=10, banner_timeout=10)
        client.get_transport().set_keepalive(5)
        # The shell receives only fixed program text. Passwords and request fields
        # travel over stdin, never in command lines, environment variables or files.
        marker = 'mossentry-request-' + secrets.token_hex(24)
        command = '/usr/bin/python3 -c ' + shlex.quote(framed_program(source, marker))
        if sudo:
            command = ('sudo -S -p "" -- ' if password is not None else 'sudo -n -- ') + command
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        if sudo and password is not None:
            stdin.write(password + '\n')
            stdin.flush()
        stdin.write(marker + '\n' + json.dumps(payload or {}) + '\n')
        stdin.flush()
        stdin.channel.shutdown_write()
        channel = stdout.channel
        output, errors = bytearray(), bytearray()
        deadline = time.monotonic() + timeout
        while True:
            if channel.recv_ready():
                output.extend(channel.recv(65536))
            if channel.recv_stderr_ready():
                errors.extend(channel.recv_stderr(65536))
            if len(output) + len(errors) > 16 * 1024 * 1024:
                raise RuntimeError('SSH response exceeded the size limit')
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f'SSH operation timed out after {timeout} seconds')
            time.sleep(0.01)
        if channel.recv_exit_status() != 0:
            message = errors.decode(errors='replace') or output.decode(errors='replace')
            if password:
                message = message.replace(password, '[redacted]')
            raise RuntimeError(message[-4000:] or 'Remote operation failed')
        return output.decode('utf-8')
    finally:
        client.close()


def run(playbook, servers, extra, passwords, timeout):
    source = Path(__file__).with_name('operations_probe.py' if playbook == 'operations.yml' else 'remote_actions.py').read_text(encoding='utf-8')
    creation_source = (Path(__file__).parent.parent / 'ansible' / 'user_creation_times.py').read_text(encoding='utf-8')
    errors = []
    for server in servers:
        try:
            payload = dict(extra)
            payload.update(operation=playbook.removesuffix('.yml'), ssh_user=server['ssh_user'])
            if playbook == 'scan_users.yml':
                payload['creation_source'] = creation_source
            if playbook == 'operations.yml':
                payload = extra['operation_payload']
            response = execute(server, source, payload,
                               sudo=bool(extra.get('operation_become')) if playbook == 'operations.yml' else playbook not in {'test_connection.yml', 'server_status.yml'},
                               password=passwords.get(server['name']), timeout=timeout)
            data = json.loads(response)
            field = {'scan_users.yml': 'scan_output_dir', 'server_status.yml': 'status_output_dir', 'operations.yml': 'operation_output_dir'}.get(playbook)
            if field:
                destination = Path(extra[field]) / (server['name'] + '.json')
                destination.write_text(json.dumps(data), encoding='utf-8')
                destination.chmod(0o600)
        except Exception as error:
            message = str(error)
            for secret in passwords.values():
                if secret:
                    message = message.replace(secret, '[redacted]')
                    message = message.replace(json.dumps(secret)[1:-1], '[redacted]')
            errors.append(f"{server['name']}: {message}")
    return not errors, '\n'.join(errors) or 'Completed successfully'
