import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryEmbed } from '../src/modules/itemlog.js';

test('item log entry card', () => {
  const e = entryEmbed({ num: 4, staff_id: '1', player: 'Jane Doe', items: '2x Medkit, $5,000', reason: 'Lost to a bug', authorized_by: '2', created_at: 0 }).toJSON();
  assert.equal(e.title, '📦 Given Items Log #4');
  assert.deepEqual(
    e.fields!.map((f) => f.name),
    ['Staff Member', 'Player Name', 'Authorized By', 'Item(s) & Amount', 'Reason for Giving'],
  );
  assert.equal(e.fields![3].value, '2x Medkit, $5,000');
});
