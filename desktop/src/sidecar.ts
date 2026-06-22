/**
 * Office-engine sidecar lifecycle.
 *
 * Spawns the SAME office-engine that runs server-side (a bundled PyInstaller
 * binary when packaged, or `python -m office_engine.mcp_server` in dev) bound to
 * loopback, with OFFICE_ROOT set to the active shared folder so it confines file
 * ops exactly like the server deployment. The bridge calls office tools through
 * an MCP client over the local Streamable-HTTP endpoint — identical protocol to
 * how the api talks to office-service, so behaviour matches.
 */
import { spawn, ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import('net').then(({ createServer }) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as any).port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class OfficeSidecar {
  private proc: ChildProcess | null = null;
  private client: Client | null = null;
  private port = 0;
  private root = '';
  private starting: Promise<void> | null = null;

  /** (Re)start the sidecar bound to `folder`. No-op if already running on it. */
  async ensure(folder: string): Promise<void> {
    if (this.proc && this.client && this.root === folder) return;
    if (this.starting) await this.starting;
    if (this.proc && this.root === folder) return;
    await this.stop();
    this.root = folder;
    this.starting = this._start();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async _start(): Promise<void> {
    this.port = await freePort();
    const env = { ...process.env, OFFICE_HOST: config.sidecar.host, OFFICE_PORT: String(this.port), OFFICE_ROOT: this.root };

    if (config.sidecar.binary) {
      this.proc = spawn(config.sidecar.binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      const [cmd, ...args] = config.sidecar.devCommand.split(' ');
      this.proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    }
    this.proc.stderr?.on('data', d => console.error('[office-sidecar]', String(d).trim()));
    this.proc.on('exit', code => { console.warn(`[office-sidecar] exited (${code})`); this.proc = null; this.client = null; });

    // Wait for /health, then open the MCP client.
    const base = `http://${config.sidecar.host}:${this.port}`;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) break;
      } catch { /* not up yet */ }
      await sleep(250);
    }
    this.client = new Client({ name: 'pulsarteam-desktop', version: '1.0.0' });
    await this.client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    console.log(`[office-sidecar] ready on ${base} (root=${this.root})`);
  }

  /** Call an office tool; returns the tool's text payload (JSON string or markdown). */
  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error('office sidecar not started');
    const result: any = await this.client.callTool({ name: tool, arguments: args });
    const text = (result?.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (result?.isError) throw new Error(text || 'office tool error');
    return text;
  }

  async stop(): Promise<void> {
    try { await this.client?.close(); } catch { /* ignore */ }
    this.client = null;
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }
}

export const officeSidecar = new OfficeSidecar();
