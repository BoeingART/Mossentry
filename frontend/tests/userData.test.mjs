import test from 'node:test';
import assert from 'node:assert/strict';
import { filteredAccounts } from '../src/userData.ts';

const users = [
  { username: 'alice', server: 'one', is_disabled: 0, is_sudo: 0 },
  { username: 'alice', server: 'two', is_disabled: 1, is_sudo: 0 },
  { username: 'bob', server: 'one', is_disabled: 0, is_sudo: 1 },
  { username: 'chen', server: 'one', is_disabled: 1, is_sudo: 0 },
];
test('disabled view includes only disabled host accounts even for mixed-access users', () => {
  assert.deepEqual(filteredAccounts(users, 'disabled', 'all').map(u => [u.username, u.server]), [['alice', 'two'], ['chen', 'one']]);
  assert.deepEqual(filteredAccounts(users, 'disabled', 'one').map(u => u.username), ['chen']);
  assert.deepEqual(filteredAccounts(users, 'sudo', 'all').map(u => u.username), ['bob']);
  assert.equal(filteredAccounts(users, 'enabled', 'all').length, 2);
  assert.equal(filteredAccounts(users, 'all', 'all').length, 4);
});
