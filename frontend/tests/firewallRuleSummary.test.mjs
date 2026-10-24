import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFirewallRule as summary } from '../src/firewallRuleSummary.ts';

test('simple UFW actions show their destination ports, ranges and protocols', () => {
  for (const [description, expected] of [
    ['allow 10901', { type: 'allow', ports: '10901' }],
    ['deny 80/tcp', { type: 'deny', ports: '80/tcp' }],
    ['reject out 53/udp', { type: 'reject', ports: '53/udp' }],
    ['limit log 22/tcp', { type: 'limit', ports: '22/tcp' }],
    ['allow 6000:6010/tcp', { type: 'allow', ports: '6000:6010/tcp' }],
    ['allow log-all 80,443,8000:8010/tcp', { type: 'allow', ports: '80,443,8000:8010/tcp' }],
  ]) assert.deepEqual(summary(description), expected, description);
});

test('extended and routed rules use destination ports rather than source ports or address numbers', () => {
  assert.deepEqual(summary('allow in from 192.0.2.80 port 1234 to any port 443 proto tcp'), { type: 'allow', ports: '443/tcp' });
  assert.deepEqual(summary('route deny proto udp from any to 2001:db8::1 port 6000:6010'), { type: 'route deny', ports: '6000:6010/udp' });
  assert.deepEqual(summary('allow from 192.0.2.10 port 2222 to any'), { type: 'allow', ports: 'all' });
});

test('quoted comments never supply a type, port, protocol or destination for the summary', () => {
  assert.deepEqual(summary("allow 10901 comment 'deny to any port 9999 proto udp'"), { type: 'allow', ports: '10901' });
  assert.deepEqual(summary('deny from 192.0.2.10 comment "allow to any port 443"'), { type: 'deny', ports: 'all' });
  assert.deepEqual(summary("allow 443/tcp comment 'it'\\''s a rule'"), { type: 'allow', ports: '443/tcp' });
});

test('all destination ports are distinct from unresolved application profiles and services', () => {
  assert.deepEqual(summary('allow from 192.0.2.0/24'), { type: 'allow', ports: 'all' });
  assert.deepEqual(summary('allow in on eth0 from any to any'), { type: 'allow', ports: 'all' });
  for (const description of ["allow 'Nginx Full'", "allow from any to any app 'Nginx Full'", 'allow https']) {
    assert.deepEqual(summary(description), { type: 'allow', ports: null });
  }
});

test('malformed and unknown rules retain an unknown summary instead of inventing fields', () => {
  for (const description of ['', 'something 443', "allow 'unterminated", 'allow 443\\']) {
    assert.deepEqual(summary(description), { type: null, ports: null });
  }
  for (const description of ['allow 0', 'allow 65536/tcp', 'allow 2000:1000', 'allow to any port']) {
    assert.deepEqual(summary(description), { type: 'allow', ports: null });
  }
});
