import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildRunnerTerminalDial } from '../execution/runnerTerminalDial.js';

// Synthetic — invented for the test, never a real key.
const API_KEY = 'SYNTHETIC-runner-key-0123456789abcdef';

const base = {
  baseUrl: 'http://claudecode-service:8000',
  agentId: 'agent-42',
  apiKey: API_KEY,
  cols: '120',
  rows: '40',
};

test('the API key never appears in the dialled URL', () => {
  const { url } = buildRunnerTerminalDial({ ...base, ownerId: 'owner-7' });
  assert.ok(!url.includes(API_KEY));
  assert.ok(!url.includes('api_key'));
});

test('the API key travels as a bearer credential', () => {
  const { headers } = buildRunnerTerminalDial(base);
  assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
});

test('the URL keeps the routing parameters the runner needs', () => {
  const { url } = buildRunnerTerminalDial({ ...base, ownerId: 'owner-7' });
  assert.equal(
    url,
    'ws://claudecode-service:8000/ws/terminal/agent-42?cols=120&rows=40&owner_id=owner-7'
  );
});

test('owner_id is omitted when there is no owner', () => {
  const { url } = buildRunnerTerminalDial({ ...base, ownerId: null });
  assert.ok(!url.includes('owner_id'));
});

test('https base URLs dial wss', () => {
  const { url } = buildRunnerTerminalDial({ ...base, baseUrl: 'https://runner.example:8000' });
  assert.ok(url.startsWith('wss://runner.example:8000/ws/terminal/'));
});

test('agent ids and owner ids are escaped', () => {
  const { url } = buildRunnerTerminalDial({
    ...base,
    agentId: 'a/b?c',
    ownerId: 'o&d=1',
  });
  assert.ok(url.includes('/ws/terminal/a%2Fb%3Fc?'));
  assert.ok(url.includes('owner_id=o%26d%3D1'));
});

test('runner context headers are preserved alongside the credential', () => {
  const { headers } = buildRunnerTerminalDial({
    ...base,
    headers: { 'X-Agent-Permissions': '{"bash":true}', 'X-LLM-Config': 'null' },
  });
  assert.equal(headers['X-Agent-Permissions'], '{"bash":true}');
  assert.equal(headers['X-LLM-Config'], 'null');
  assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
});

test('a context header cannot overwrite the credential', () => {
  const { headers } = buildRunnerTerminalDial({
    ...base,
    headers: { Authorization: 'Bearer SYNTHETIC-attacker-supplied' },
  });
  assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
});
