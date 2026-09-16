import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** Two clones sharing an identity reproduce the multi-agent attribution bug. */
export function gitFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pulsar-commits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'agent');
  const peer = join(root, 'peer');
  const remote = join(root, 'remote.git');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Shared Agent',
    GIT_AUTHOR_EMAIL: 'agent@pulsarteam.local',
    GIT_COMMITTER_NAME: 'Shared Agent',
    GIT_COMMITTER_EMAIL: 'agent@pulsarteam.local',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, repo);
  git(repo, 'commit', '--allow-empty', '-m', 'baseline');
  git(repo, 'push', '-u', 'origin', 'main');
  git(root, 'clone', remote, peer);
  const baselineHead = git(repo, 'rev-parse', 'HEAD');
  const startedAt = new Date().toISOString();
  const executionManager = {
    async exec(_agentId: string, command: string) {
      return {
        stdout: execSync(command, {
          cwd: repo,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
        stderr: '',
      };
    },
  };
  return { git, repo, peer, remote, baselineHead, startedAt, executionManager };
}
