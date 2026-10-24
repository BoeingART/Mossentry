import test from 'node:test';
import assert from 'node:assert/strict';
// Load Mantine before providing the minimal browser storage fixture.
import '@mantine/core';

let fixtureId = 0;
async function preferences(t, native) {
  const original = globalThis.window;
  const storage = new Map();
  const writes = [];
  globalThis.window = {
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    ...(native && { mossentryAppearance: {
      get: () => ({ ...native }),
      set: async (key, value) => { native[key] = value; writes.push([key, value]); },
    } }),
  };
  t.after(() => {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  });
  const { colorSchemeManager } = await import(`../src/preferences.ts?fixture=${++fixtureId}`);
  return { manager: colorSchemeManager, storage, writes };
}

test('fresh appearance follows the computer and browser storage retains manual and automatic choices', async t => {
  const { manager, storage } = await preferences(t);
  assert.equal(manager.get('auto'), 'auto');
  for (const scheme of ['light', 'dark', 'auto']) {
    manager.set(scheme);
    assert.equal(storage.get('mossentry-color-scheme'), scheme);
    assert.equal(manager.get('auto'), scheme);
  }
  manager.clear();
  assert.equal(manager.get('auto'), 'auto');
});

test('native preferences preserve an existing choice and resetting restores automatic mode', async t => {
  const native = { language: 'zh', colorScheme: 'dark' };
  const { manager, storage, writes } = await preferences(t, native);
  storage.set('mossentry-color-scheme', 'light');
  assert.equal(manager.get('auto'), 'dark');
  manager.set('light');
  assert.equal(native.colorScheme, 'light');
  manager.clear();
  assert.equal(native.colorScheme, 'auto');
  assert.equal(manager.get('auto'), 'auto');
  assert.deepEqual(writes, [['colorScheme', 'light'], ['colorScheme', 'auto']]);
  assert.equal(native.language, 'zh');
});
