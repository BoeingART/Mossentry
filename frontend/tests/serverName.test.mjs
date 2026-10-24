import test from 'node:test';
import assert from 'node:assert/strict';
import { serverNameError } from '../src/serverName.ts';

test('server names support mixed case, Chinese, spaces and symbols', () => {
  for (const name of [
    'MyServer', '1 Server', '服务器 · GPU (3), #1 🚀', 'my.server/a\\b',
    'Quoted "server" & <tag>; $value', '服'.repeat(80), '🚀'.repeat(80),
  ]) {
    assert.equal(serverNameError(name), null, name);
  }
});

test('server names reject blank, multiline, control and oversized values', () => {
  for (const name of [
    '', '   ', '\nserver', 'server\r', 'server\tname', 'server\0', 'server\x7f',
    'server\x85', 'server\u2028name', 'server\u2029name', '服'.repeat(81), '🚀'.repeat(81),
  ]) {
    assert.equal(serverNameError(name), 'Use a server name of 1–80 characters without line breaks or control characters.', JSON.stringify(name));
  }
});

test('reserved server names remain unavailable regardless of case', () => {
  for (const name of ['all', 'ALL', 'Ungrouped', 'MANAGED']) {
    assert.equal(serverNameError(name), 'This server name is reserved', name);
  }
});
