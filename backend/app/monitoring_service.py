"""Short, authenticated, read-only SSH samples independent of management jobs."""
import json
import subprocess
import time
from collections import OrderedDict
from pathlib import Path
from threading import Lock

_guard = Lock()
_inflight = set()
_cache = OrderedDict()
CACHE_SECONDS = 3


class SampleBusy(Exception):
    pass


def inspect_resources(server):
    # Connection changes must never reuse a previous host's sample.
    identity = tuple(server[key] for key in ('id', 'hostname', 'port', 'ssh_user', 'key_path'))
    with _guard:
        cached = _cache.get(identity)
        if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1]
        if identity in _inflight:
            raise SampleBusy()
        _inflight.add(identity)
    try:
        command = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
                   '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
                   '-p', str(server['port']), '-i', server['key_path'],
                   '--', f"{server['ssh_user']}@{server['hostname']}", '/usr/bin/python3 -']
        result = subprocess.run(command, input=Path(__file__).with_name('resource_probe.py').read_text(),
                                capture_output=True, text=True, timeout=30, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr or 'Resource sample failed')
        sample = json.loads(result.stdout)
        if not isinstance(sample, dict) or not {'checked_at', 'cpu', 'memory', 'disks', 'gpu', 'warnings'} <= sample.keys():
            raise ValueError('Invalid resource sample')
        with _guard:
            _cache[identity] = (time.monotonic(), sample)
            _cache.move_to_end(identity)
            while len(_cache) > 64:
                _cache.popitem(last=False)
        return sample
    finally:
        with _guard:
            _inflight.discard(identity)
