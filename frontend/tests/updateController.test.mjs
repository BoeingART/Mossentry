import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateController } from '../src/updateController.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const calls = { check: 0, download: 0, install: 0 };
  const transport = {
    check: async () => { calls.check++; return '0.2.0'; },
    download: async progress => { calls.download++; progress({ received: 50, total: 100 }); },
    install: async () => { calls.install++; },
    ...overrides,
  };
  return { updater: new UpdateController(transport), calls };
}

test('no newer release, missing manifest and offline checks keep Update hidden', async () => {
  for (const check of [async () => null, async () => { throw new Error('GitHub unavailable'); }]) {
    const { updater, calls } = fixture({ check });
    await updater.check();
    assert.deepEqual(updater.snapshot(), { phase: 'hidden' });
    assert.equal(calls.download, 0);
  }
});

test('a newer release stays available without downloading until the user clicks', async () => {
  const { updater, calls } = fixture();
  await updater.poll();
  assert.deepEqual(updater.snapshot(), { phase: 'available', version: '0.2.0' });
  await updater.check();
  await updater.poll();
  await updater.poll();
  await updater.install();
  assert.deepEqual(updater.snapshot(), { phase: 'available', version: '0.2.0' });
  assert.deepEqual(calls, { check: 1, download: 0, install: 0 });
  await updater.download();
  assert.equal(updater.snapshot().phase, 'ready');
  assert.deepEqual(calls, { check: 1, download: 1, install: 0 });
});

test('a clicked download only becomes ready after verification', async () => {
  const verified = deferred();
  let progress;
  const { updater, calls } = fixture({ download: report => { progress = report; return verified.promise; } });
  const phases = [];
  updater.subscribe(() => phases.push(updater.snapshot().phase));
  await updater.check();
  const download = updater.download();
  assert.equal(updater.snapshot().phase, 'downloading');
  assert.equal(updater.snapshot().version, '0.2.0');
  progress({ received: 100, total: 100 });
  assert.equal(updater.snapshot().phase, 'downloading');
  await updater.install();
  assert.equal(calls.install, 0);
  verified.resolve();
  await download;
  assert.equal(updater.snapshot().phase, 'ready');
  progress({ received: 100, total: 100 });
  assert.equal(updater.snapshot().phase, 'ready');
  assert.equal(phases.at(-1), 'ready');
});

test('repeated mounts, polling and clicks share one check and one download', async () => {
  const checked = deferred(), downloaded = deferred();
  let checks = 0, downloads = 0;
  const { updater } = fixture({
    check: () => { checks++; return checked.promise; },
    download: () => { downloads++; return downloaded.promise; },
  });
  await updater.download();
  assert.equal(downloads, 0);
  const first = updater.check();
  await updater.poll();
  await updater.download();
  assert.equal(downloads, 0);
  checked.resolve('0.2.0');
  await first;
  await updater.poll();
  assert.equal(checks, 1);
  assert.equal(downloads, 0);
  const download = updater.download();
  await updater.download();
  await updater.poll();
  assert.equal(downloads, 1);
  downloaded.resolve();
  await download;
  await updater.download();
  await updater.poll();
  assert.equal(downloads, 1);
});

test('a rejected signature never becomes installable and retries only after a click', async () => {
  let downloads = 0;
  const { updater, calls } = fixture({ download: async () => {
    if (++downloads === 1) throw { detail: 'Could not download or verify the update. Please retry.' };
  } });
  await updater.check();
  await updater.download();
  assert.equal(updater.snapshot().phase, 'error');
  assert.equal(updater.snapshot().retry, 'download');
  await updater.install();
  assert.equal(calls.install, 0);
  await updater.poll();
  await updater.poll();
  await updater.check();
  assert.equal(updater.snapshot().phase, 'error');
  assert.equal(downloads, 1);
  await updater.download();
  assert.equal(updater.snapshot().phase, 'ready');
  assert.equal(downloads, 2);
});

test('failed hidden checks recover on a subsequent poll', async () => {
  let checks = 0;
  const { updater, calls } = fixture({ check: async () => {
    if (++checks === 1) throw new Error('Offline');
    return '0.2.0';
  } });
  await updater.poll();
  await updater.poll();
  assert.equal(updater.snapshot().phase, 'available');
  assert.equal(calls.download, 0);
});

test('a running server task blocks installation; retry reuses the downloaded package and never installs automatically', async () => {
  let installs = 0;
  const { updater, calls } = fixture({ install: async () => {
    if (++installs === 1) throw { detail: 'Another server operation is running. Wait for it to finish and retry' };
  } });
  await updater.check();
  await updater.download();
  await updater.install();
  assert.equal(updater.snapshot().phase, 'error');
  assert.equal(updater.snapshot().retry, 'install');
  await updater.poll();
  assert.equal(installs, 1);
  await updater.install();
  assert.equal(updater.snapshot().phase, 'installing');
  assert.equal(installs, 2);
  assert.equal(calls.download, 1);
});

test('double clicks install once and unknown download sizes still reach readiness', async () => {
  const installed = deferred();
  let installs = 0;
  const { updater } = fixture({
    download: async report => report({ received: 128, total: null }),
    install: () => { installs++; return installed.promise; },
  });
  await updater.check();
  await updater.download();
  assert.equal(updater.snapshot().phase, 'ready');
  const first = updater.install();
  await updater.install();
  assert.equal(installs, 1);
  installed.resolve();
  await first;
});
