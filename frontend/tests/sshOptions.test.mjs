import test from 'node:test';
import assert from 'node:assert/strict';
import { sshOption, setSshOption } from '../src/sshOptions.ts';

test('SSH fields edit case-insensitive options while preserving commands and repeated identity files', () => {
  const text = 'proxyjump = bastion\nIdentityFile "~/.ssh/key one"\nIdentityFile ~/.ssh/second\nProxyCommand nc -x "proxy host:1080" %h %p';
  assert.equal(sshOption(text, 'ProxyJump'), 'bastion');
  const edited = setSshOption(text, 'ProxyJump', 'user@relay:2222');
  assert.equal(sshOption(edited, 'ProxyJump'), 'user@relay:2222');
  assert.equal(sshOption(edited, 'ProxyCommand'), 'nc -x "proxy host:1080" %h %p');
  assert.equal(edited.match(/IdentityFile/g).length, 2);
  assert.equal(sshOption(setSshOption(edited, 'ProxyJump', ''), 'ProxyJump'), '');
});
