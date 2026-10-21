import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalLists } from '../src/approvalData.ts';
test('a list retains all operations and per-user credential downloads alongside legacy history', () => {
  const lists = approvalLists({
    approval_batches: [{ id: 5, status: 'pending', created_at: '2026-10-21' }],
    actions: [{ id: 3, batch_id: 5, private_key_ready: true }, { id: 2, batch_id: 5 },
      { id: 1, batch_id: null, status: 'executed', requested_at: '2026-10-20' }],
  });
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[0].items.map(item => item.id), [2, 3]);
  assert.equal(lists[0].items[1].private_key_ready, true);
  assert.equal(lists[1].legacy, true);
});
