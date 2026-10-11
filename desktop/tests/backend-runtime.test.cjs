const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { backendCommand } = require('../backend-runtime.cjs');

test('packaged macOS launches its bundled Python from paths containing spaces', () => {
  const resourcesPath = '/Applications/Mossentry App.app/Contents/Resources';
  const command = backendCommand({ platform: 'darwin', packaged: true, resourcesPath });
  assert.equal(command.executable, path.join(resourcesPath, 'runtime/bin/python3'));
  assert.deepEqual(command.args, [path.join(resourcesPath, 'backend/launch.py')]);
});

test('Windows launches native bundled Python without a shell or WSL', () => {
  const resourcesPath = 'C:/Users/A $USER & B/Applications/Mossentry';
  const command = backendCommand({ platform: 'win32', packaged: true, resourcesPath });
  assert.equal(command.executable, path.join(resourcesPath, 'runtime/python.exe'));
  assert.deepEqual(command.args, [path.join(resourcesPath, 'backend/launch.py')]);
});

test('development and explicit Python overrides remain available', () => {
  const command = backendCommand({ platform: 'darwin', packaged: false, projectRoot: '/project', python: '/custom/python' });
  assert.equal(command.executable, '/custom/python');
  assert.deepEqual(command.args, [path.join('/project', 'backend/launch.py')]);
});
