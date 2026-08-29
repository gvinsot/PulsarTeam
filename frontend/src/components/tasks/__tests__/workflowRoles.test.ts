// Regression guard for the workflow editor's role dropdowns.
//
// The bug: the editor was handed `agents.filter(a => a.boardId === activeBoardId)`,
// so on any board whose agents carry a different boardId (or none) every role
// select collapsed to just "Role…"/"Any agent" + "Automatic (AI picks role)",
// even though the Agents view listed those agents. Run with `npm test` from
// frontend/ (node's built-in runner strips the TS types).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTO_ROLE, buildRoleOptions, collectRoles } from '../workflowRoles.ts';

const BOARD = 'board-1';

const AGENTS = [
  { id: 'a1', name: 'Dev One', role: 'developer', boardId: BOARD, enabled: true },
  { id: 'a2', name: 'Dev Two', role: 'Developer', boardId: BOARD },
  { id: 'a3', name: 'Archie', role: 'architect', boardId: BOARD },
  { id: 'a4', name: 'Testy', role: 'tester', boardId: 'board-2' },
  { id: 'a5', name: 'Homeless', role: 'reviewer', boardId: null },
  { id: 'a6', name: 'Off', role: 'designer', boardId: BOARD, enabled: false },
  { id: 'a7', name: 'Roleless', role: '', boardId: BOARD },
];

test('board roles list every role held by an enabled agent on the board', () => {
  const { boardRoles } = buildRoleOptions(AGENTS, BOARD);
  assert.deepEqual(boardRoles, ['architect', 'developer']);
});

test('roles of agents outside the board stay selectable', () => {
  // The actual regression: these used to vanish entirely.
  const { otherRoles } = buildRoleOptions(AGENTS, BOARD);
  assert.deepEqual(otherRoles, ['reviewer', 'tester']);
});

test('no role from the Agents view can go missing', () => {
  const { boardRoles, otherRoles } = buildRoleOptions(AGENTS, BOARD);
  assert.deepEqual([...boardRoles, ...otherRoles].sort(), collectRoles(AGENTS).sort());
});

test('a board with no agent of its own still offers every role', () => {
  const { boardRoles, otherRoles } = buildRoleOptions(AGENTS, 'board-empty');
  assert.deepEqual(boardRoles, []);
  assert.deepEqual(otherRoles, ['architect', 'developer', 'reviewer', 'tester']);
});

test('disabled agents and blank roles are ignored', () => {
  const { boardRoles, otherRoles } = buildRoleOptions(AGENTS, BOARD);
  assert.ok(![...boardRoles, ...otherRoles].includes('designer'));
  assert.ok(![...boardRoles, ...otherRoles].includes(''));
});

test('roles are deduped case-insensitively and sorted', () => {
  const agents = [
    { role: 'Zulu', boardId: BOARD },
    { role: 'alpha', boardId: BOARD },
    { role: 'ALPHA', boardId: BOARD },
  ];
  assert.deepEqual(buildRoleOptions(agents, BOARD).boardRoles, ['alpha', 'Zulu']);
});

test('a role already configured stays selectable when its agents are gone', () => {
  const { boardRoles, otherRoles } = buildRoleOptions(AGENTS, BOARD, 'deleted-role');
  assert.ok(!boardRoles.includes('deleted-role'));
  assert.ok(otherRoles.includes('deleted-role'));
  // …but a role that already exists is not duplicated, whatever its casing.
  assert.deepEqual(buildRoleOptions(AGENTS, BOARD, 'DEVELOPER').otherRoles, ['reviewer', 'tester']);
});

test('the auto sentinel and empty values are never offered as a role', () => {
  for (const value of [AUTO_ROLE, '', '   ', undefined, null]) {
    const { boardRoles, otherRoles } = buildRoleOptions(AGENTS, BOARD, value as string);
    assert.deepEqual([...boardRoles, ...otherRoles].sort(), collectRoles(AGENTS).sort());
  }
});

test('no board id means every agent counts as a board agent', () => {
  const { boardRoles, otherRoles } = buildRoleOptions(AGENTS, null);
  assert.deepEqual(boardRoles, ['architect', 'developer', 'reviewer', 'tester']);
  assert.deepEqual(otherRoles, []);
});

test('missing / malformed input degrades to an empty list', () => {
  assert.deepEqual(buildRoleOptions(undefined, BOARD), { boardRoles: [], otherRoles: [] });
  assert.deepEqual(buildRoleOptions(null as any, null), { boardRoles: [], otherRoles: [] });
  assert.deepEqual(collectRoles([null, undefined, {}] as any), []);
});

// Source-level guard: the grouping above only works if the modals receive the
// *unfiltered* agent list. Re-adding a board filter at the call site is exactly
// how the bug shipped, so pin it here.
test('TasksBoard hands the workflow modals the full agent list + a board id', () => {
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'TasksBoard.tsx'), 'utf8');
  for (const component of ['WorkflowEditor', 'InstructionsEditModal']) {
    const start = source.indexOf(`<${component}`);
    assert.ok(start !== -1, `${component} is no longer rendered by TasksBoard`);
    const props = source.slice(start, source.indexOf('/>', start));
    assert.match(props, /agents=\{agents\}/, `${component} must receive the unfiltered agents list`);
    assert.match(props, /boardId=\{activeBoardId\}/, `${component} must receive the active board id`);
  }
});
