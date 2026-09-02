import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFieldProjection,
  projectObject,
  projectionIncludesField,
} from '../../lib/projection.js';
import { parseAgentProjection } from '../agentManager/projection.js';
import { parseTaskProjection } from '../taskProjection.js';

const presets = {
  list: { omit: ['history', 'conversationHistory'] },
  summary: { fields: ['id', 'name', 'status'] },
};

const source = {
  id: 'item-1',
  name: 'Agent Smith',
  status: 'idle',
  history: [{ type: 'message', body: 'heavy' }],
  conversationHistory: [{ role: 'assistant', content: 'heavy' }],
  small: true,
};

test('projection view omits heavy fields from list payloads', () => {
  const projection = parseFieldProjection({ view: 'list' }, presets, 'list');
  const projected = projectObject(source, projection, ['id']);

  assert.deepEqual(projected, {
    id: 'item-1',
    name: 'Agent Smith',
    status: 'idle',
    small: true,
  });
  assert.equal(projectionIncludesField(projection, 'history'), false);
});

test('fields selects an explicit top-level whitelist', () => {
  const projection = parseFieldProjection({ fields: 'name,status,history' }, presets, 'list');
  const projected = projectObject(source, projection, ['id']);

  assert.deepEqual(projected, {
    id: 'item-1',
    name: 'Agent Smith',
    status: 'idle',
    history: [{ type: 'message', body: 'heavy' }],
  });
  assert.equal(projectionIncludesField(projection, 'conversationHistory'), false);
});

test('include re-enables a field omitted by a preset view', () => {
  const projection = parseFieldProjection({ view: 'list', include: 'history' }, presets, 'list');
  const projected = projectObject(source, projection, ['id']);

  assert.equal(Array.isArray(projected.history), true);
  assert.equal('conversationHistory' in projected, false);
  assert.equal(projectionIncludesField(projection, 'history'), true);
});

test('omit removes an explicitly selected field unless include re-enables it', () => {
  const omitted = parseFieldProjection({ fields: 'name,history', omit: 'history' }, presets, null);
  assert.deepEqual(projectObject(source, omitted, ['id']), {
    id: 'item-1',
    name: 'Agent Smith',
  });
  assert.equal(projectionIncludesField(omitted, 'history'), false);

  const included = parseFieldProjection(
    { fields: 'name,history', omit: 'history', include: 'history' },
    presets,
    null
  );
  assert.equal('history' in projectObject(source, included, ['id']), true);
  assert.equal(projectionIncludesField(included, 'history'), true);
});

test('projection ignores punctuation-based path syntax', () => {
  const projection = parseFieldProjection(
    { fields: 'id,name,history.items,conversationHistory[0]' },
    presets,
    null
  );
  const projected = projectObject(source, projection, ['id']);

  assert.deepEqual(projected, {
    id: 'item-1',
    name: 'Agent Smith',
  });
});

test('agent list preset excludes heavy detail fields by default', () => {
  const projection = parseAgentProjection({}, 'list');

  assert.equal(projectionIncludesField(projection, 'conversationHistory'), false);
  assert.equal(projectionIncludesField(projection, 'projectContexts'), false);
  assert.equal(projectionIncludesField(projection, 'ragDocuments'), false);
  assert.equal(
    projectionIncludesField(parseAgentProjection({ view: 'detail' }, 'list'), 'ragDocuments'),
    true
  );
});

test('task list preset excludes history but keeps commit metadata', () => {
  const projection = parseTaskProjection({}, 'list');

  assert.equal(projectionIncludesField(projection, 'history'), false);
  assert.equal(projectionIncludesField(projection, 'commits'), true);
  assert.equal(
    projectionIncludesField(parseTaskProjection({ view: 'summary' }, 'list'), 'commits'),
    false
  );
  assert.equal(
    projectionIncludesField(parseTaskProjection({ include: 'history' }, 'list'), 'history'),
    true
  );
});
