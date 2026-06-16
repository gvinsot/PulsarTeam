import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWorkflowColumnIds,
  resolveWorkflowStatus,
  slugifyColumnId,
} from '../workflow/index.js';

test('resolveWorkflowStatus prefers column label before id', () => {
  const columns = [
    { id: 'ready', label: 'Inbox' },
    { id: 'review', label: 'Ready' },
  ];

  const resolved = resolveWorkflowStatus(columns, 'Ready');

  assert.equal(resolved?.id, 'review');
  assert.equal(resolved?.matchedBy, 'label');
});

test('resolveWorkflowStatus falls back to column id', () => {
  const columns = [
    { id: 'in_progress', label: 'In Progress' },
  ];

  const resolved = resolveWorkflowStatus(columns, 'in_progress');

  assert.equal(resolved?.id, 'in_progress');
  assert.equal(resolved?.matchedBy, 'id');
});

test('normalizeWorkflowColumnIds renames ids from changed labels and rewrites transitions', () => {
  const previousWorkflow = {
    columns: [
      { id: 'code', label: 'Code' },
      { id: 'done', label: 'Done' },
    ],
    transitions: [
      { from: 'code', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'done' }] },
    ],
  };
  const nextWorkflow = {
    columns: [
      { id: 'code', label: 'Quality Review' },
      { id: 'done', label: 'Done' },
    ],
    transitions: [
      { from: 'code', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'done' }] },
      { from: 'done', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'code' }] },
    ],
  };

  const { workflow, renames } = normalizeWorkflowColumnIds(nextWorkflow, previousWorkflow);

  assert.deepEqual(renames, [{ from: 'code', to: 'quality_review' }]);
  assert.equal(workflow.columns?.[0].id, 'quality_review');
  assert.equal(workflow.transitions?.[0].from, 'quality_review');
  assert.equal(workflow.transitions?.[1].actions[0].target, 'quality_review');
});

test('normalizeWorkflowColumnIds keeps stable ids reserved when a rename collides', () => {
  const previousWorkflow = {
    columns: [
      { id: 'todo', label: 'Todo' },
      { id: 'done', label: 'Done' },
    ],
  };
  const nextWorkflow = {
    columns: [
      { id: 'todo', label: 'Done' },
      { id: 'done', label: 'Done' },
    ],
  };

  const { workflow, renames } = normalizeWorkflowColumnIds(nextWorkflow, previousWorkflow);

  assert.equal(workflow.columns?.[1].id, 'done');
  assert.equal(workflow.columns?.[0].id, 'done_2');
  assert.deepEqual(renames, [{ from: 'todo', to: 'done_2' }]);
});

test('slugifyColumnId normalizes accents and separators', () => {
  assert.equal(slugifyColumnId('QA - A faire !'), 'qa_a_faire');
  assert.equal(slugifyColumnId('Etude & validation'), 'etude_validation');
});
