const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preferenceStore } = require('../preferences.cjs');

function directory(t) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'mossentry-appearance-'));
  t.after(() => fs.rmSync(result, { recursive: true, force: true }));
  return result;
}

test('appearance survives a new app process independently of the service origin', t => {
  const root = directory(t);
  const store = preferenceStore(root);
  store.set('language', 'zh');
  store.set('colorScheme', 'dark');
  assert.deepEqual(preferenceStore(root).get(), { language: 'zh', colorScheme: 'dark' });
  const copy = store.get();
  copy.language = 'en';
  assert.equal(store.get().language, 'zh');
});

test('malformed or unknown preferences cannot change other app settings', t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'appearance.json'), 'not JSON');
  assert.deepEqual(preferenceStore(root).get(), {});
  fs.writeFileSync(path.join(root, 'appearance.json'), JSON.stringify({ language: 'xx', colorScheme: 'dark', database: '/tmp/unwanted' }));
  const store = preferenceStore(root);
  assert.deepEqual(store.get(), { colorScheme: 'dark' });
  assert.throws(() => store.set('database', '/tmp/unwanted'));
  assert.throws(() => store.set('language', 'xx'));
  assert.deepEqual(preferenceStore(root).get(), { colorScheme: 'dark' });
});
