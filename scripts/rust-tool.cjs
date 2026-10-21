// Locate rustup without requiring shell-profile edits. Select usable Apple CLI
// tools for this child only; never change xcode-select or accept licenses.
const { spawn, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, delimiter } = require('node:path');
const { homedir } = require('node:os');
const [tool, ...args] = process.argv.slice(2);
const env = { ...process.env };
const cargoBin = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin');
// Windows commonly spells this key "Path". Spreading process.env produces a
// case-sensitive object; creating a second "PATH" can discard all system tools.
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${cargoBin}${delimiter}${env[pathKey] || ''}`;
if (process.platform === 'darwin' && !env.DEVELOPER_DIR) {
  const current = spawnSync('cc', ['--version'], { env, stdio: 'ignore' });
  const cli = '/Library/Developer/CommandLineTools';
  if (current.status !== 0 && existsSync(cli)) {
    const candidate = { ...env, DEVELOPER_DIR: cli };
    if (spawnSync('cc', ['--version'], { env: candidate, stdio: 'ignore' }).status === 0) env.DEVELOPER_DIR = cli;
  }
}
const command = tool === 'tauri' ? process.execPath : (process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const childArgs = tool === 'tauri' ? [require.resolve('@tauri-apps/cli/tauri.js'), ...args] : args;
const child = spawn(command, childArgs, { env, stdio: 'inherit' });
child.on('error', error => { console.error(`Could not start ${tool}: ${error.message}. Install Rust from https://rustup.rs.`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
