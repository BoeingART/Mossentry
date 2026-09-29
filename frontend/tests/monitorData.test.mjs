import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSample, chartSegments, cpuPercent, gpuPercent, REFRESH_MS, timePosition, WINDOW_MS } from '../src/monitorData.ts';

test('five-second sampling retains exactly the rolling five-minute interval', () => {
  assert.equal(REFRESH_MS, 5000);
  assert.equal(WINDOW_MS, 300000);
  let history = [];
  for (let index = 0; index <= 80; index++) {
    history = appendSample(history, { checked_at: String(index) }, index * REFRESH_MS);
  }
  assert.equal(history.length, 61);
  assert.equal(history[0].time, 100000);
  assert.equal(history.at(-1).time - history[0].time, WINDOW_MS);
});

test('time coordinates keep a five-minute width even when there are only two samples', () => {
  assert.equal(timePosition(300000, 600000), 0);
  assert.equal(timePosition(450000, 600000), 0.5);
  assert.equal(timePosition(600000, 600000), 1);
  assert.ok(Math.abs(timePosition(595000, 600000) - 59 / 60) < 1e-10);
});

test('missing and unsupported samples break curves instead of drawing zero or bridging an outage', () => {
  const segments = chartSegments([
    { time: 0, value: 30 }, { time: 5000, value: 40 }, { time: 10000, value: null },
    { time: 15000, value: 50 }, { time: 35000, value: 60 }, { time: 40000, value: Number.NaN },
    { time: 45000, value: 0 },
  ], 45000);
  assert.deepEqual(segments.map(segment => segment.map(point => point.value)), [[30, 40], [50], [60], [0]]);
});

test('curves stay within 0–100 and omit points outside the visible time window', () => {
  assert.deepEqual(chartSegments([
    { time: 0, value: 50 }, { time: 300001, value: -1 },
    { time: 305001, value: 140 }, { time: 320001, value: 50 },
  ], 310001), [[{ time: 300001, value: 0 }, { time: 305001, value: 100 }]]);
});

test('cached samples do not gain new timestamps and old histories expire on resume', () => {
  let history = appendSample([], { checked_at: 'same' }, 1000);
  history = appendSample(history, { checked_at: 'same' }, 2000);
  assert.deepEqual(history.map(point => point.time), [1000]);
  history = appendSample(history, null, 400000);
  assert.deepEqual(history, [{ time: 400000, sample: null }]);
});

test('changing a user filter recomputes CPU and GPU history without mixing whole-host totals', () => {
  const sample = { cpu: { percent: 80, users: [
    { username: 'alice', cpu_percent: 25 }, { username: 'bob', cpu_percent: 15 },
  ] } };
  const device = { percent: 90, processes: [
    { username: 'alice', sm_percent: 40 }, { username: 'bob', sm_percent: 20 }, { username: null, sm_percent: 10 },
  ] };
  assert.equal(cpuPercent(sample, []), 80);
  assert.equal(cpuPercent(sample, ['alice']), 25);
  assert.equal(cpuPercent(sample, ['alice', 'bob']), 40);
  assert.equal(gpuPercent(device, []), 90);
  assert.equal(gpuPercent(device, ['alice']), 40);
  assert.equal(gpuPercent(device, ['alice', 'bob']), 60);
  assert.equal(gpuPercent(device, ['missing']), null);
  assert.equal(gpuPercent(undefined, []), null);
  assert.equal(gpuPercent({ processes: [{ username: 'alice', sm_percent: null }] }, ['alice']), null);
});


test('confirmed idle users show zero but failed or partial GPU readings stay unavailable', () => {
  const device = { process_utilization_available: true, processes: [
    { username: 'alice', sm_percent: 0 }, { username: 'bob', sm_percent: 70 },
    { username: 'unknown', sm_percent: null },
  ] };
  assert.equal(gpuPercent(device, ['alice']), 0);
  assert.equal(gpuPercent(device, ['missing']), 0);
  assert.equal(gpuPercent(device, ['alice', 'bob']), 70);
  assert.equal(gpuPercent(device, ['bob', 'unknown']), null);
  assert.equal(gpuPercent({ process_utilization_available: false, processes: [] }, ['missing']), null);
});
