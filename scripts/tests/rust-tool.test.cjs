const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function launch(platform, env) {
  let launch;
  const child = { on() {}, kill() {} };
  const modules = {
    'node:child_process': { spawn: (command, args, options) => { launch = { command, args, ...options }; return child; }, spawnSync: () => ({ status: 0 }) },
    'node:fs': { existsSync: () => true },
    'node:path': platform === 'win32' ? path.win32 : path.posix,
    'node:os': { homedir: () => platform === 'win32' ? 'C:\\Users\\builder' : '/home/builder' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../rust-tool.cjs'), 'utf8'), {
    require: name => modules[name],
    process: { platform, env, argv: ['node', 'rust-tool.cjs', 'cargo', '--version'], on() {} },
    console,
  });
  return launch;
}

test('Windows Rust launch preserves system, Perl and compiler paths with a mixed-case Path key', () => {
  const original = 'C:\\Windows\\System32;C:\\Strawberry\\perl\\bin;C:\\Compiler';
  const result = launch('win32', { Path: original, USERPROFILE: 'C:\\Users\\builder' });
  assert.equal(result.command, 'cargo.exe');
  assert.equal(result.env.Path, `C:\\Users\\builder\\.cargo\\bin;${original}`);
  assert.deepEqual(Object.keys(result.env).filter(key => key.toLowerCase() === 'path'), ['Path']);
  assert.equal(result.env.USERPROFILE, 'C:\\Users\\builder');
});

test('Unix Rust launch retains the existing PATH and an explicit Cargo home', () => {
  const result = launch('darwin', { PATH: '/usr/bin:/bin', CARGO_HOME: '/custom/cargo' });
  assert.equal(result.env.PATH, '/custom/cargo/bin:/usr/bin:/bin');
  assert.equal(result.command, 'cargo');
});
