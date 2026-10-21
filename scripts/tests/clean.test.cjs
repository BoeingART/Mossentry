const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clean } = require('../clean.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mossentry-clean-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['dist/index.html', 'src-tauri/target/debug/app', 'src-tauri/gen/schema.json',
    'node_modules/.vite/cache', 'node_modules/dependency/index.js', 'src-tauri/remote/__pycache__/probe.pyc',
    'remote-tests/old.pyc', '.DS_Store', '.git/objects/history', 'frontend/src/App.tsx',
    'data/mossentry.db', 'package-lock.json', 'src-tauri/Cargo.lock']) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'preserve-or-remove-fixture');
  }
  return root;
}
test('clean removes generated files while preserving source, data, Git and installed dependencies', t => {
  const root = fixture(t);
  clean(root);
  for (const name of ['dist', 'src-tauri/target', 'src-tauri/gen', 'node_modules/.vite', 'src-tauri/remote/__pycache__', 'remote-tests/old.pyc', '.DS_Store']) assert.equal(fs.existsSync(path.join(root, name)), false, name);
  for (const name of ['frontend/src/App.tsx', '.git/objects/history', 'data/mossentry.db', 'package-lock.json', 'src-tauri/Cargo.lock', 'node_modules/dependency/index.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'preserve-or-remove-fixture', name);
});
test('clean all removes dependencies but never follows a directory symlink', t => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mossentry-clean-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, '.DS_Store'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
  clean(root, { all: true });
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  assert.equal(fs.readFileSync(path.join(outside, '.DS_Store'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(root, 'data/mossentry.db')), true);
});
test('dry run reports removals without changing files', t => {
  const root = fixture(t);
  const report = clean(root, { all: true, dryRun: true });
  assert.ok(report.includes('dist'));
  assert.ok(report.includes('node_modules'));
  for (const name of ['dist/index.html', 'node_modules/.vite/cache', '.DS_Store', 'remote-tests/old.pyc']) assert.equal(fs.existsSync(path.join(root, name)), true);
});
test('default clean preserves cache directories behind a dependency symlink', t => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mossentry-clean-dependency-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, '.vite'));
  fs.writeFileSync(path.join(outside, '.vite/cache'), 'external-cache');
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  clean(root);
  assert.equal(fs.readFileSync(path.join(outside, '.vite/cache'), 'utf8'), 'external-cache');
});
