const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setting, databasePath, userDataDirectory } = require('../branding.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mossentry-branding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('new installations use Mossentry and mossentry.db', t => {
  const base = fixture(t);
  assert.equal(userDataDirectory(base, {}), path.join(base, 'Mossentry'));
  assert.equal(databasePath(base), path.join(base, 'mossentry.db'));
});

test('legacy installations retain their database, WAL, and credentials in place', t => {
  for (const name of ['Server Manager', 'server-manager-desktop', 'luo-server-manager-desktop', 'Dry Cactus', 'Cactus']) {
    const base = fixture(t);
    const old = path.join(base, name);
    const data = path.join(old, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'server_manager.db'), 'existing database');
    fs.writeFileSync(path.join(data, 'server_manager.db-wal'), 'pending data');
    fs.writeFileSync(path.join(data, 'srvmgr.passwd'), 'saved credential');
    assert.equal(userDataDirectory(base, {}), old);
    assert.equal(databasePath(data), path.join(data, 'server_manager.db'));
    assert.equal(fs.readFileSync(path.join(data, 'server_manager.db-wal'), 'utf8'), 'pending data');
    assert.equal(fs.readFileSync(path.join(data, 'srvmgr.passwd'), 'utf8'), 'saved credential');
  }
});

test('existing Mossentry data takes priority over legacy data', t => {
  const base = fixture(t);
  for (const name of ['Mossentry', 'Server Manager']) {
    const data = path.join(base, name, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'server_manager.db'), 'legacy');
  }
  const current = path.join(base, 'Mossentry');
  fs.writeFileSync(path.join(current, 'data', 'mossentry.db'), 'current');
  assert.equal(userDataDirectory(base, {}), current);
  assert.equal(databasePath(path.join(current, 'data')), path.join(current, 'data', 'mossentry.db'));
});

test('explicit paths win and old environment variables remain supported', t => {
  const base = fixture(t);
  const old = path.join(base, 'old');
  const current = path.join(base, 'new');
  assert.equal(userDataDirectory(base, { SRVMGR_USER_DATA_DIR: old }), old);
  assert.equal(userDataDirectory(base, { SRVMGR_USER_DATA_DIR: old, MOSSENTRY_USER_DATA_DIR: current }), current);
  assert.equal(setting('PYTHON', { SRVMGR_PYTHON: 'old-python' }), 'old-python');
  assert.equal(setting('PYTHON', { SRVMGR_PYTHON: 'old-python', MOSSENTRY_PYTHON: 'new-python' }), 'new-python');
});
