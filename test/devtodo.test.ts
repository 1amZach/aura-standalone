import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSuggestion, renderBoard, type TodoItem } from '../src/modules/devtodo.js';

const item = (num: number, status: TodoItem['status'], extra: Partial<TodoItem> = {}): TodoItem => ({
  id: num, num, author_id: '1', text: `thing ${num}`, files_url: null, status, note: '', updated_by: null, created_at: 0, updated_at: 0, ...extra,
});

test('checks messages before adding', () => {
  assert.equal(checkSuggestion('Fix dog food for police k9s', false), null);
  assert.ok(checkSuggestion('fix', false));
  assert.ok(checkSuggestion('<@123> <:pog:456>', false));
  assert.equal(checkSuggestion('', true), null);
  assert.ok(checkSuggestion('x'.repeat(2000), false));
});

test('board groups by status and hides old finished items', () => {
  const now = 30 * 86400e3;
  const [e] = renderBoard([item(1, 'open'), item(2, 'progress'), item(3, 'done', { updated_at: now - 86400e3 }), item(4, 'wont', { updated_at: 0 })], now);
  const d = e.toJSON().description!;
  assert.ok(d.indexOf('In progress') < d.indexOf('Open'));
  assert.match(d, /#3/);
  assert.doesNotMatch(d, /#4/);
  assert.equal(e.toJSON().title, '🛠️ Dev To-Do List');
});

test('empty board says how to add', () => {
  assert.match(renderBoard([])[0].toJSON().description!, /Send a message/);
});
