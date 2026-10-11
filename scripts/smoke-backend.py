"""Check a relocated packaged backend without touching real hosts or user data."""
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parent.parent
python = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'build/runtime/bin/python3'
backend = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else root / 'backend'
with tempfile.TemporaryDirectory(prefix='mossentry-smoke-') as temp:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with open(Path(temp) / 'stderr.log', 'w+') as log:
        process = subprocess.Popen([str(python), str(backend / 'launch.py')], cwd=backend,
                                   stdin=subprocess.PIPE, stdout=log, stderr=log, text=True)
        try:
            process.stdin.write(json.dumps({
                'dataDirectory': temp, 'databasePath': str(Path(temp) / 'test.db'),
                'token': 'smoke-test-token', 'port': port, 'nativeSSH': True,
            }) + '\n')
            process.stdin.flush()
            origin = f'http://127.0.0.1:{port}'
            for attempt in range(100):
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                try:
                    request = urllib.request.Request(origin + '/health', headers={'X-Desktop-Token': 'smoke-test-token'})
                    with urllib.request.urlopen(request, timeout=1) as response:
                        assert response.status == 200
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.2)
            else:
                raise RuntimeError('Packaged service did not become healthy')
            try:
                urllib.request.urlopen(origin + '/api/dashboard')
                raise AssertionError('Unauthenticated request was allowed')
            except urllib.error.HTTPError as error:
                assert error.code == 403
            for endpoint in ['/', '/api/dashboard']:
                request = urllib.request.Request(origin + endpoint, headers={'X-Desktop-Token': 'smoke-test-token'})
                with urllib.request.urlopen(request) as response:
                    body = response.read()
                    assert response.status == 200
                    if endpoint == '/':
                        assert b'<div id="root"></div>' in body
            process.stdin.close()
            assert process.wait(timeout=15) == 0, 'Service did not exit cleanly after parent disconnected'
            print('Packaged backend: health, authentication, UI, dashboard and shutdown passed.')
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
