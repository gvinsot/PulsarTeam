// run_command must tell the model whether the command failed (ADR
// docs/adr-sandbox-agentic-loop-2026-11-06.md, Lot 1 §1). A non-zero command
// that printed output stays success:true, so the exit status rides in the
// output (`exit_code=N` header) and in the role:'tool' JSON (`exit_code`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { executeTool, execExitCode, runCommandResult } from '../agentTools.js';
import type { ExecutionProvider } from '../execution/executionProvider.js';
import { toolResultContent } from '../agentManager/nativeToolHistory.js';

const execLocal = promisify(execCb);

/** Provider whose exec() runs a real shell, like the local provider. */
function shellProvider(
  exec: (command: string) => Promise<{ stdout: string; stderr: string }> = command =>
    execLocal(command, { shell: '/bin/sh' })
): ExecutionProvider {
  return {
    hasEnvironment: () => true,
    getProject: () => null,
    ensureProject: async () => {},
    exec: async (_agentId: string, command: string) => exec(command),
  } as unknown as ExecutionProvider;
}

/** Same rejection the runner provider builds from an /exec-shell error. */
function runnerError(code: number, output: string) {
  return Object.assign(new Error(`Command failed with exit code ${code}`), {
    stdout: `${output}\n[exit code: ${code}]`,
    stderr: `${output}\n[exit code: ${code}]`,
  });
}

const run = (command: string, provider = shellProvider()) =>
  executeTool('run_command', [command], null, provider, 'agent-1');

const modelView = (result: unknown) =>
  JSON.parse(toolResultContent(result as Parameters<typeof toolResultContent>[0], Infinity));

test('`false` reaches the model as exit_code=1', async () => {
  const result = await run('false');
  assert.equal(result.meta?.exitCode, 1);
  assert.match(result.result || '', /^exit_code=1\n/);
  assert.match(String(result.error), /^exit_code=1: /);
  const view = modelView(result);
  assert.equal(view.exit_code, 1);
  assert.equal(view.truncated, false);
});

test('`true` reaches the model as exit_code=0', async () => {
  const result = await run('true');
  assert.equal(result.success, true);
  assert.equal(result.result, 'exit_code=0\n(no output)');
  const view = modelView(result);
  assert.equal(view.exit_code, 0);
  assert.equal(view.success, true);
});

test('a failing command with output keeps it and reports its exit code', async () => {
  const result = await run('echo boom; exit 3');
  assert.equal(result.success, true, 'output is still a usable result');
  assert.equal(result.meta?.exitCode, 3);
  assert.match(result.result || '', /^exit_code=3\nboom/);
  assert.equal(modelView(result).exit_code, 3);
});

test('runner-shaped failure: exit code parsed from the message, output not doubled', async () => {
  const provider = shellProvider(async () => {
    throw runnerError(2, 'FAIL tests');
  });
  const result = await run('npm test', provider);
  assert.equal(result.meta?.exitCode, 2);
  const body = result.result || '';
  assert.match(body, /^exit_code=2\nFAIL tests/);
  assert.equal(body.split('FAIL tests').length, 2, 'combined output appears once');
});

test('transport error without output still carries an exit code', async () => {
  const provider = shellProvider(async () => {
    throw new Error('fetch failed');
  });
  const result = await run('ls', provider);
  assert.equal(result.success, false);
  assert.equal(result.meta?.exitCode, 1);
  assert.equal(result.error, 'exit_code=1: fetch failed');
});

test('long output keeps head and tail and is flagged truncated', async () => {
  const result = runCommandResult('cmd', 0, `${'x'.repeat(12_000)}\nFINAL ERROR`);
  assert.equal(result.meta?.truncated, true);
  const body = result.result || '';
  assert.ok(body.length <= 10_000, 'header included in the 10k budget');
  assert.match(body, /^exit_code=0\n/);
  assert.match(body, /omitted/);
  assert.match(body, /FINAL ERROR$/, 'the tail survives truncation');
  assert.equal(modelView(result).truncated, true);
});

test('execExitCode prefers a numeric code, then the runner text, else 1', () => {
  assert.equal(execExitCode(Object.assign(new Error('x'), { code: 127 })), 127);
  assert.equal(execExitCode(new Error('x'), 'out\n[exit code: 5]'), 5);
  assert.equal(execExitCode(new Error('timeout')), 1);
});

test('toolResultContent leaves results without meta unchanged', () => {
  assert.deepEqual(modelView({ success: true, result: 'ok' }), {
    success: true,
    result: 'ok',
    error: null,
  });
});
