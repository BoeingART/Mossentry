import test from 'node:test';
import assert from 'node:assert/strict';
import { FirewallController, firewallSource, firewallState } from '../src/firewallData.ts';

const server = (id, extra = {}) => ({ id, name: `host${id}`, hostname: `192.0.2.${id}`, port: 22,
  ssh_user: 'admin', key_path: '~/.ssh/id_ed25519', enabled: 1, has_sudo_password: false,
  ssh_backend: 'native', ssh_alias: '', ssh_options: '', ssh_jump_config: '', ...extra });
const status = enabled => ({ available: true, enabled, ssh_allowed: true, ssh_port: 22,
  management_ip: '192.0.2.100', revision: 'rules-1', rules: [] });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('firewall rows distinguish enabled, disabled, unavailable, failed, pending and paused servers', () => {
  const host = server(1);
  assert.equal(firewallState(host, { phase: 'ready', status: status(true) }), 'enabled');
  assert.equal(firewallState(host, { phase: 'ready', status: status(false) }), 'disabled');
  assert.equal(firewallState(host, { phase: 'ready', status: { available: false } }), 'unavailable');
  assert.equal(firewallState(host, { phase: 'error', error: 'SSH failed' }), 'error');
  assert.equal(firewallState(host, { phase: 'checking' }), 'checking');
  assert.equal(firewallState(host), 'waiting');
  assert.equal(firewallState(server(1, { enabled: 0 }), { phase: 'ready', status: status(true) }), 'paused');
});

test('list checks run serially, skip paused hosts and continue after a failure', async () => {
  const calls = [];
  let running = 0;
  const controller = new FirewallController(async (host, body) => {
    assert.equal(running++, 0, 'the operation lock must never be requested concurrently');
    calls.push([host.id, body.operation]);
    await Promise.resolve();
    running--;
    if (host.id === 2) throw new Error('SSH connection failed');
    return host.id === 3 ? { available: false } : status(true);
  });
  const hosts = [server(1), server(2), server(3), server(4, { enabled: 0 })];
  await controller.checkAll(hosts, () => true);
  assert.deepEqual(calls, [[1, 'status'], [2, 'status'], [3, 'status']]);
  assert.equal(firewallState(hosts[0], controller.snapshot()[firewallSource(hosts[0])]), 'enabled');
  assert.equal(firewallState(hosts[1], controller.snapshot()[firewallSource(hosts[1])]), 'error');
  assert.equal(firewallState(hosts[2], controller.snapshot()[firewallSource(hosts[2])]), 'unavailable');
});

test('replayed effects share one check, and opening details stops the remaining list checks', async () => {
  const checked = deferred();
  const calls = [];
  const controller = new FirewallController(async (host, body) => {
    calls.push([host.id, body.operation]);
    if (host.id === 1) await checked.promise;
    return status(true);
  });
  let active = true;
  const list = controller.checkAll([server(1), server(2), server(3)], () => active);
  const duplicate = controller.check(server(1));
  await Promise.resolve();
  active = false;
  const detail = controller.check(server(3));
  assert.deepEqual(calls, [[1, 'status']]);
  checked.resolve();
  await Promise.all([list, duplicate, detail]);
  assert.deepEqual(calls, [[1, 'status'], [3, 'status']]);
});

test('a detail change waits for in-flight status checks and updates the correct list row', async () => {
  const checked = deferred();
  const calls = [];
  const controller = new FirewallController(async (host, body) => {
    calls.push([host.id, body.operation]);
    if (body.operation === 'status') await checked.promise;
    return status(body.operation !== 'disable');
  });
  const check = controller.check(server(1));
  const change = controller.request(server(2), { operation: 'disable' });
  await Promise.resolve();
  assert.deepEqual(calls, [[1, 'status']]);
  checked.resolve();
  await Promise.all([check, change]);
  assert.deepEqual(calls, [[1, 'status'], [2, 'disable']]);
  assert.equal(firewallState(server(1), controller.snapshot()[firewallSource(server(1))]), 'enabled');
  assert.equal(firewallState(server(2), controller.snapshot()[firewallSource(server(2))]), 'disabled');
});

test('late responses from old connection settings never become the edited server status', async () => {
  const checked = deferred();
  const controller = new FirewallController(async () => { await checked.promise; return status(true); });
  const old = server(1), edited = server(1, { hostname: '192.0.2.90' });
  const check = controller.check(old);
  checked.resolve();
  await check;
  assert.equal(firewallState(edited, controller.snapshot()[firewallSource(edited)]), 'waiting');
  await controller.check(edited);
  assert.equal(firewallState(edited, controller.snapshot()[firewallSource(edited)]), 'enabled');
});

test('failed requests clear stale status, permit refresh, and never retry changes automatically', async () => {
  const calls = [];
  const controller = new FirewallController(async (_host, body) => {
    calls.push(body.operation);
    if (body.operation === 'disable') throw new Error('Connection lost');
    return status(true);
  });
  const host = server(1);
  await controller.check(host);
  await assert.rejects(controller.request(host, { operation: 'disable' }), /Connection lost/);
  assert.deepEqual(controller.snapshot()[firewallSource(host)], { phase: 'error', error: 'Connection lost' });
  await controller.check(host);
  assert.deepEqual(calls, ['status', 'disable', 'status']);
  await assert.rejects(controller.request(server(2, { enabled: 0 }), { operation: 'enable' }), /paused/);
  assert.deepEqual(calls, ['status', 'disable', 'status']);
});
