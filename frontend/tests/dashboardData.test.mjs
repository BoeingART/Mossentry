import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, accessCounts, dashboardAccounts, dateTime, growthWindow, smoothPath, totalAt } from '../src/dashboardData.ts';

const history = [{ date: '2020-01-01', total: 2, added: 2 }, { date: '2026-09-10', total: 3, added: 1 }, { date: '2026-10-06', total: 5, added: 2 }];

test('all-time curve starts at zero and reaches the present cumulative count', () => {
  const window = growthWindow(history, '2026-10-06', 'all');
  assert.equal(window.start, dateTime('2020-01-01') - DAY);
  assert.equal(window.end, dateTime('2026-10-06'));
  assert.equal(window.points[0].total, 0);
  assert.equal(window.points.at(-1).total, 5);
});

test('shorter ranges retain users created before the visible period', () => {
  const window = growthWindow(history, '2026-10-06', '30');
  assert.equal(window.points[0].total, 2);
  assert.equal(window.points.at(-1).total, 5);
  assert.equal(totalAt(history, dateTime('2026-10-01')), 3);
  assert.equal(totalAt(history, dateTime('2010-01-01')), 0);
});

test('quiet periods are flat and empty histories never invent users', () => {
  const window = growthWindow(history.slice(0, 1), '2026-10-06', '30');
  assert.equal(window.points.length, 2);
  assert.deepEqual(window.points.map(point => point.total), [2, 2]);
  assert.deepEqual(growthWindow([], '2026-10-06', 'all').points.map(point => point.total), [0, 0]);
});

test('access breakdown includes root and management accounts, deduplicated across hosts', () => {
  assert.deepEqual(accessCounts([
    { username: 'root', is_sudo: 1 }, { username: 'root', is_sudo: 1 },
    { username: 'srvmgr', is_sudo: 1 }, { username: 'operator', is_sudo: 0 },
    { username: 'alice', is_sudo: 0 }, { username: 'alice', is_sudo: 1 },
  ]), { total: 4, sudo: 3, standard: 1 });
});

test('curve handles remain within cumulative endpoints', () => {
  assert.equal(smoothPath([{ x: 0, y: 100 }, { x: 100, y: 50 }, { x: 200, y: 50 }]),
    'M 0 100 C 45 100, 55 50, 100 50 C 145 50, 155 50, 200 50');
});

test('dashboard excludes only low-UID disabled accounts before deduplicating access', () => {
  const users = [
    { username: 'daemon', uid: 1, is_disabled: 1, is_sudo: 0, server: 'one' },
    { username: 'root', uid: 0, is_disabled: 0, is_sudo: 1, server: 'one' },
    { username: 'srvmgr', uid: 999, is_disabled: 0, is_sudo: 1, server: 'one' },
    { username: 'disabled-user', uid: 1000, is_disabled: 1, is_sudo: 0, server: 'one' },
    { username: 'mixed', uid: 999, is_disabled: 1, is_sudo: 1, server: 'one' },
    { username: 'mixed', uid: 1000, is_disabled: 0, is_sudo: 0, server: 'two' },
  ];
  assert.deepEqual(dashboardAccounts(users).map(user => user.username), ['root', 'srvmgr', 'disabled-user', 'mixed']);
  assert.equal(dashboardAccounts(users).filter(user => user.server === 'one').length, 3);
  assert.deepEqual(accessCounts(users), { total: 4, sudo: 2, standard: 2 });
  assert.equal(users.length, 6);
});
