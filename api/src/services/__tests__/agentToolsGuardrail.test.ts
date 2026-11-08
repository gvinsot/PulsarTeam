import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { executeTool } from '../agentTools.js';
import { ExecutionProvider } from '../execution/executionProvider.js';

function createProvider() {
  const provider = new ExecutionProvider();
  mock.method(provider, 'hasEnvironment', () => true);
  mock.method(provider, 'getProject', () => 'test-project');
  const exec = mock.method(provider, 'exec', async () => ({ stdout: 'ok', stderr: '' }));
  return { provider, exec };
}

describe('run_command accident guardrail', () => {
  const blocked = [
    'shutdown now',
    'reboot',
    'poweroff',
    'halt',
    'mkfs.ext4 /dev/sda',
    'fdisk /dev/sda',
    'iptables -F',
    'nft flush ruleset',
    'ufw disable',
    'useradd example',
    'userdel example',
    'usermod example',
    'passwd example',
    'crontab -r',
    'systemctl stop example',
    'service example stop',
    'nc -l 1234',
    'ncat -l 1234',
    'socat TCP-LISTEN:1234 -',
    'nmap localhost',
    'masscan localhost',
    'tcpdump',
    'tshark',
    'mkfifo pipe',
    'mknod device b 1 1',
    'ls; sudo reboot',
    'ls;halt',
    'ls &&   halt',
    'ls || halt',
    'ls & halt',
    'printf example | halt',
    '( halt )',
    'echo $(halt)',
    'sudo service example stop',
    'printf example | xargs passwd',
    'xargs sudo reboot',
    '  shutdown now  ',
    'cat /proc/self/environ',
    'cat /proc/123/environ',
    'echo example > /dev/tcp/localhost/1234',
    'echo example > /dev/udp/localhost/1234',
    'env bash -i >& output',
  ];

  for (const command of blocked) {
    it(`refuses ${JSON.stringify(command)} before provider execution`, async () => {
      const { provider, exec } = createProvider();
      const result = await executeTool('run_command', [command], 'test-project', provider, 'agent');
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /Command refused by the safety guardrail/);
      assert.equal(exec.mock.callCount(), 0);
    });
  }

  const allowed = [
    'cd runner-service && ls',
    'cd runner-service && find . -name test.py',
    'grep -r halt src',
    'npm run service:start',
    'git log --format=%nft',
    'cat /etc/passwd',
    'cat docs/shutdown.md',
    'echo reboot poweroff mkfs fdisk iptables nft ufw',
    'echo useradd userdel usermod crontab systemctl service',
    'echo nc -l ncat -l socat nmap masscan tcpdump tshark mkfifo mknod',
    'cd nft && ls',
    'halted --help',
    'service_worker --help',
    'nc localhost 1234',
    'ncat localhost 1234',
  ];

  for (const command of allowed) {
    it(`passes ${JSON.stringify(command)} to the provider`, async () => {
      const { provider, exec } = createProvider();
      const result = await executeTool('run_command', [command], 'test-project', provider, 'agent');
      assert.equal(result.success, true);
      assert.equal(exec.mock.callCount(), 1);
    });
  }
});
