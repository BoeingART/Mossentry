"""End-to-end Rust SSH test; binds only loopback and removes its disposable container."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import ssl
import shutil
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]

def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)

with tempfile.TemporaryDirectory(prefix='mossentry-ssh-test-') as temporary:
    directory = Path(temporary)
    (directory / 'disposable-fixture').touch()
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(directory / 'id_ed25519'))
    (directory / 'wrong_known_hosts').write_text('')
    (directory / '.dockerignore').write_text('id_ed25519\n')
    ca_file = ssl.get_default_verify_paths().cafile
    if not ca_file:
        raise RuntimeError('A system CA certificate bundle is required for the HTTPS test fixture')
    shutil.copyfile(ca_file, directory / 'ca-certificates.crt')
    dockerfile = directory / 'Dockerfile'
    dockerfile.write_text('''FROM ubuntu:22.04
COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://|https://|g; s/ main restricted/ main/; / universe/d; / multiverse/d; /backports/d' /etc/apt/sources.list
RUN apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update -qq && apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y -qq --no-install-recommends ca-certificates openssh-server python3 sudo passwd && mkdir -p /run/sshd
RUN useradd -m -g operator -s /bin/bash operator && useradd -m -s /bin/bash nopass && echo 'operator:fixture-password' | chpasswd && echo 'nopass:fixture-unused' | chpasswd
RUN echo 'operator ALL=(ALL) ALL' > /etc/sudoers.d/operator && echo 'nopass ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/nopass && chmod 440 /etc/sudoers.d/*
COPY id_ed25519.pub /tmp/client.pub
RUN for u in operator nopass; do mkdir -p /home/$u/.ssh; cp /tmp/client.pub /home/$u/.ssh/authorized_keys; chown -R $u:$u /home/$u/.ssh; chmod 700 /home/$u/.ssh; chmod 600 /home/$u/.ssh/authorized_keys; done
CMD ["/usr/sbin/sshd", "-D", "-e", "-o", "PasswordAuthentication=no"]
''')
    tag = 'mossentry-ssh-fixture:' + directory.name.rsplit('-', 1)[-1]
    container = None
    try:
        build_env = dict(os.environ)
        proxy_args = []
        for key in ('http_proxy', 'https_proxy'):
            value = os.environ.get(key) or os.environ.get(key.upper())
            if value:
                url = urlsplit(value)
                if url.hostname in ('127.0.0.1', 'localhost'):
                    value = urlunsplit(url._replace(netloc=url.netloc.replace(url.hostname, 'host.docker.internal')))
                build_env[key] = value
                proxy_args.extend(['--build-arg', key])
        run('docker', 'build', *proxy_args, '-t', tag, str(directory), env=build_env)
        container = run('docker', 'run', '-d', '--rm', '-p', '127.0.0.1::22', tag, capture_output=True).stdout.strip()
        info = json.loads(run('docker', 'inspect', container, capture_output=True).stdout)[0]
        port = info['NetworkSettings']['Ports']['22/tcp'][0]['HostPort']
        # Trust only the key read directly from this local container, never an unverified scan.
        for algorithm in ('ed25519', 'rsa', 'ecdsa'):
            public = run('docker', 'exec', container, 'cat', f'/etc/ssh/ssh_host_{algorithm}_key.pub', capture_output=True).stdout.split()
            (directory / f'known_hosts_{algorithm}').write_text(f'[127.0.0.1]:{port} {public[0]} {public[1]}\n')
        shutil.copyfile(directory / 'known_hosts_ed25519', directory / 'known_hosts')
        public = run('docker', 'exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub', capture_output=True).stdout.split()
        with (directory / 'known_hosts').open('a') as hosts:
            hosts.write(f'127.0.0.1 {public[0]} {public[1]}\n')
        shutil.copyfile(directory / 'known_hosts', directory / 'known_hosts_hashed')
        run('ssh-keygen', '-q', '-H', '-f', str(directory / 'known_hosts_hashed'), capture_output=True)
        env = {**os.environ, 'MOSSENTRY_TEST_SSH_DIR': str(directory), 'MOSSENTRY_TEST_SSH_PORT': port}
        run('node', 'scripts/rust-tool.cjs', 'cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--no-default-features', '--test', 'live_ssh', '--', '--ignored', '--nocapture', cwd=ROOT, env=env)
        run('docker', 'exec', container, 'python3', '-c', "print('Disposable SSH integration completed')")
    finally:
        if container:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL)
        subprocess.run(['docker', 'image', 'rm', tag], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
