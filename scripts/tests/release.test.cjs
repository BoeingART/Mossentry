const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageRelease, createManifest } = require('../release.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mossentry-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  const bundle = path.join(root, 'src-tauri/target/release/bundle');
  for (const [folder, filename] of [['dmg', 'Mossentry.dmg'], ['macos', 'Mossentry.app.tar.gz'], ['nsis', 'Mossentry-setup.exe']]) {
    fs.mkdirSync(path.join(bundle, folder), { recursive: true });
    fs.writeFileSync(path.join(bundle, folder, filename), folder);
    if (folder !== 'dmg') fs.writeFileSync(path.join(bundle, folder, `${filename}.sig`), `signature-${folder}\n`);
  }
  return root;
}

test('both Mac architectures and Windows have distinct, signed assets and complete manifest entries', t => {
  const root = fixture(t);
  const targets = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'];
  for (const target of targets) stageRelease(root, target, true);
  const directory = path.join(root, 'release-stage');
  const manifest = createManifest(root, directory, 'BoeingART/Mossentry', 'v0.2.0', new Date('2026-10-21T00:00:00Z'));
  assert.deepEqual(Object.keys(manifest.platforms), targets);
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.pub_date, '2026-10-21T00:00:00.000Z');
  for (const target of targets) {
    const entry = manifest.platforms[target];
    const filename = decodeURIComponent(new URL(entry.url).pathname.split('/').at(-1));
    assert.equal(fs.existsSync(path.join(directory, filename)), true);
    assert.equal(fs.readFileSync(path.join(directory, `${filename}.sig`), 'utf8').trim(), entry.signature);
    assert.equal(entry.url.startsWith('https://github.com/BoeingART/Mossentry/releases/download/v0.2.0/'), true);
    assert.equal(filename.includes(target), true);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'latest.json'), 'utf8')), manifest);
});

test('unsigned preview builds stage installers without requiring a signing key', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'src-tauri/target/release/bundle/macos/Mossentry.app.tar.gz.sig'));
  stageRelease(root, 'darwin-aarch64', false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'release-stage')), ['Mossentry_0.2.0_darwin-aarch64.dmg']);
  assert.throws(() => stageRelease(root, 'darwin-aarch64', true));
});

test('publishing refuses incomplete platforms, mismatched versions and altered signatures', t => {
  const root = fixture(t);
  stageRelease(root, 'darwin-aarch64', true);
  const directory = path.join(root, 'release-stage');
  assert.throws(() => createManifest(root, directory, 'BoeingART/Mossentry', 'v0.2.0'));
  stageRelease(root, 'darwin-x86_64', true);
  stageRelease(root, 'windows-x86_64', true);
  assert.throws(() => createManifest(root, directory, 'BoeingART/Mossentry', 'v0.3.0'), /version/);
  const fragmentPath = path.join(directory, 'windows-x86_64.json');
  const fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8'));
  fs.writeFileSync(fragmentPath, JSON.stringify({ ...fragment, version: '0.1.0' }));
  assert.throws(() => createManifest(root, directory, 'BoeingART/Mossentry', 'v0.2.0'), /metadata/);
  fs.writeFileSync(fragmentPath, JSON.stringify(fragment));
  fs.writeFileSync(path.join(directory, `${fragment.file}.sig`), 'wrong-signature');
  assert.throws(() => createManifest(root, directory, 'BoeingART/Mossentry', 'v0.2.0'), /signature/);
});
