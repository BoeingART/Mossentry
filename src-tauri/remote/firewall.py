"""Agentless UFW management. All mutations use argv, never a shell."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

SSH_BLOCKED = 'SSH access is not explicitly allowed. Add an inbound TCP allow rule for the SSH port and management IP before enabling the firewall.'
STALE_RULES = 'Firewall rules changed. Refresh the rules before deleting.'


def command(args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=20,
                            env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})
    if result.returncode:
        raise RuntimeError('UFW command failed. Check UFW configuration and management permissions.')
    return result.stdout


def saved_rules(ufw):
    output = command([ufw, 'show', 'added'])
    rules = []
    for line in output.splitlines():
        if not line.startswith('ufw '):
            continue
        args = shlex.split(line)[1:]
        if not args or args[0] not in {'allow', 'deny', 'reject', 'limit', 'route'}:
            raise RuntimeError('Unsupported UFW rule format. Review the rules on the server.')
        rules.append({'id': len(rules), 'description': line[4:], 'args': args})
    revision = hashlib.sha256(json.dumps(rules, sort_keys=True).encode()).hexdigest()
    return rules, revision


def connection(value):
    """The SSH shell supplies this before sudo strips its environment."""
    try:
        client, client_port, host, port = value.split()
        client, host = ipaddress.ip_address(client), ipaddress.ip_address(host)
        client_port, port = int(client_port), int(port)
        if client.version != host.version or not 1 <= port <= 65535 or not 1 <= client_port <= 65535:
            return None
        return client, client_port, host, port
    except (ValueError, TypeError):
        return None


def port_matches(spec, port):
    return any(int(bounds[0]) <= port <= int(bounds[-1])
               for part in spec.split(',') for bounds in [part.split(':')])


def packet_match(tokens, peer):
    """Conservatively evaluate persisted iptables input rules for a new SSH TCP packet.

    None means a restriction/jump cannot be proven safe, so enabling fails closed.
    UFW expands service names and app profiles into these numeric rules, even inactive.
    """
    client, client_port, host, port = peer
    unknown = False
    target = None
    i = 2  # -A chain
    while i < len(tokens):
        key = tokens[i]
        if i + 1 == len(tokens):
            return None, None
        value = tokens[i + 1]
        i += 2
        if key in {'-s', '--source', '-d', '--destination'}:
            address = client if key in {'-s', '--source'} else host
            if address not in ipaddress.ip_network(value, strict=False):
                return False, None
        elif key in {'-p', '--protocol'}:
            if value not in {'tcp', '6', 'all', '0'}:
                return False, None
        elif key in {'--dport', '--dports', '--destination-port', '--sport', '--sports', '--source-port'}:
            selected = client_port if key in {'--sport', '--sports', '--source-port'} else port
            if not port_matches(value, selected):
                return False, None
        elif key in {'-m', '--match'}:
            unknown |= value not in {'tcp', 'multiport', 'comment'}
        elif key in {'-j', '--jump'}:
            target = value
        elif key not in {'--comment', '--reject-with'}:
            unknown = True
    return (None if unknown else True), target


def ssh_allowed(peer):
    if peer is None:
        return False
    version = peer[0].version
    try:
        if version == 6 and not re.search(r'^IPV6\s*=\s*yes\s*$', Path('/etc/default/ufw').read_text(), re.M):
            return False
        path = '/etc/ufw/user6.rules' if version == 6 else '/etc/ufw/user.rules'
        text = Path(path).read_text()
        for line in text.splitlines():
            if not line.startswith('-A ufw-user-input '):
                continue
            matches, target = packet_match(shlex.split(line), peer)
            if matches is False or target in {'LOG', 'NFLOG'}:
                continue
            if matches is None:
                return False
            # The first matching terminal rule wins. Unknown chains fail closed.
            return target == 'ACCEPT'
    except (OSError, ValueError):
        return False
    return False


def snapshot(ufw, peer):
    status = command([ufw, 'status'])
    if not re.search(r'^Status: (?:active|inactive)\s*$', status, re.M):
        raise RuntimeError('Could not read UFW status.')
    rules, revision = saved_rules(ufw)
    return {'available': True, 'enabled': bool(re.search(r'^Status: active\s*$', status, re.M)),
            'rules': [{k: v for k, v in rule.items() if k != 'args'} for rule in rules],
            'revision': revision, 'ssh_allowed': ssh_allowed(peer),
            'ssh_port': peer[3] if peer else None, 'management_ip': str(peer[0]) if peer else None}


def rule_args(payload):
    if type(payload.get('port')) is not int or not 1 <= payload['port'] <= 65535:
        raise ValueError('Enter a port between 1 and 65535.')
    if payload.get('protocol') not in {'tcp', 'udp', 'any'}:
        raise ValueError('Select TCP, UDP or both protocols.')
    if payload.get('action') not in {'allow', 'deny'}:
        raise ValueError('Select allow or deny.')
    source = payload.get('source')
    if source != 'any':
        try:
            source = str(ipaddress.ip_network(source, strict=False))
        except (ValueError, TypeError):
            raise ValueError('Enter a valid source IP address or CIDR network.') from None
    args = [payload['action'], 'in', 'from', source, 'to', 'any', 'port', str(payload['port'])]
    if payload['protocol'] != 'any':
        args += ['proto', payload['protocol']]
    return args


def run(payload, ssh_connection=''):
    operation = payload.get('operation')
    if operation not in {'status', 'enable', 'disable', 'add', 'delete'}:
        raise ValueError('Unknown firewall operation.')
    ufw = shutil.which('ufw', path='/usr/sbin:/usr/bin:/sbin:/bin')
    if not ufw:
        return {'available': False}
    peer = connection(ssh_connection)
    if operation == 'add':
        args = rule_args(payload)  # Validate everything before any command can mutate state.
        command([ufw, *args])
    elif operation == 'delete':
        rules, revision = saved_rules(ufw)
        index = payload.get('rule_id')
        if revision != payload.get('revision') or type(index) is not int or not 0 <= index < len(rules):
            return {'error': STALE_RULES}
        # Delete the saved specification, covering its IPv4 and IPv6 counterparts.
        args = rules[index]['args']
        args = ['route', 'delete', *args[1:]] if args[0] == 'route' else ['delete', *args]
        command([ufw, '--force', *args])
    elif operation == 'enable':
        current = snapshot(ufw, peer)
        if not current['enabled']:
            # Recheck persisted rules inside the privileged operation; never trust UI state.
            if not ssh_allowed(peer):
                return {'error': SSH_BLOCKED}
            command([ufw, '--force', 'enable'])
    elif operation == 'disable':
        command([ufw, '--force', 'disable'])
    result = snapshot(ufw, peer)
    if operation in {'enable', 'disable'} and result['enabled'] != (operation == 'enable'):
        return {'error': 'Firewall state did not match the requested change. Refresh and check the server.'}
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.loads(sys.stdin.readline()), sys.argv[1] if len(sys.argv) > 1 else '')))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
