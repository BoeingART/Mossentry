"""Assemble a relocatable native Python runtime using pinned uv/Python versions."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
os.chdir(root)
os.environ['UV_PYTHON_INSTALL_DIR'] = str(root / 'build/python-downloads')
os.environ['UV_PYTHON_INSTALL_BIN'] = 'false'
subprocess.run(['uv', 'python', 'install', '3.12.11'], check=True)
python = subprocess.check_output(['uv', 'python', 'find', '--managed-python', '3.12.11'], text=True).strip()
source = Path(subprocess.check_output([python, '-c', 'import sys; print(sys.prefix)'], text=True).strip())
destination = root / 'build/runtime'
if destination.exists():
    shutil.rmtree(destination)
shutil.copytree(source, destination, symlinks=os.name != 'nt')
bundled = destination / ('python.exe' if os.name == 'nt' else 'bin/python3')
subprocess.run(['uv', 'pip', 'install', '--python', str(bundled), '--break-system-packages',
                '--link-mode', 'copy', '-r', 'backend/requirements.txt'], check=True)
if os.name != 'nt':
    wrapper = destination / 'bin/ansible-playbook'
    wrapper.write_text('#!/bin/sh\nexec "$(dirname "$0")/python3" -m ansible.cli.playbook "$@"\n')
    wrapper.chmod(0o755)
subprocess.run([str(bundled), '-c', 'import fastapi, uvicorn, paramiko, passlib'], check=True)
print(f'Native runtime prepared at {destination}')
