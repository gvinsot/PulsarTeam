/**
 * Reverse bridge: the desktop's 2nd socket to the remote platform.
 *
 * Connects to the platform api with the user's JWT and role 'desktop-bridge'
 * (the server puts it in the `desktop:${userId}` room). The Local Folder MCP
 * connector emit-with-acks `bridge:tool:call`; we run the op locally — fs tools
 * through the allow-listed fsGuard, office tools through the office sidecar — and
 * return the result via the ack. Every call is recorded in an activity log the
 * UI surfaces, so the user SEES what agents did.
 */
import { io, Socket } from 'socket.io-client';
import { config } from './config.js';
import { FolderGuard, FS_TOOLS, dispatchFsTool, GuardError } from './fsGuard.js';
import { officeSidecar } from './sidecar.js';

// Wire contract — must match api/src/ws/events.ts.
const EV = {
  REGISTER: 'bridge:register',
  TOOL_CALL: 'bridge:tool:call',
} as const;

export type Activity = { at: number; tool: string; path?: string; ok: boolean; error?: string };

export class Bridge {
  private socket: Socket | null = null;
  private token: string | null = null;
  readonly guard = new FolderGuard();
  readonly activity: Activity[] = [];
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify() { for (const fn of this.listeners) fn(); }

  get connected(): boolean { return !!this.socket?.connected; }
  get folders(): string[] { return this.guard.folders; }

  /** (Re)connect with the freshest JWT. Idempotent for an unchanged token. */
  setToken(token: string | null): void {
    if (!token || token === this.token) return;
    this.token = token;
    this.socket?.disconnect();
    this.socket = io(config.serverUrl, {
      auth: (cb) => cb({ token: this.token, role: 'desktop-bridge' }),
      transports: ['websocket', 'polling'],
    });
    this.socket.on('connect', () => { console.log('🔌 bridge connected'); this.register(); this.notify(); });
    this.socket.on('disconnect', () => { console.log('🔌 bridge disconnected'); this.notify(); });
    this.socket.on('connect_error', (e) => console.error('bridge connect_error:', e.message));
    this.socket.on(EV.TOOL_CALL, (payload, ack) => this.handleToolCall(payload, ack));
  }

  /** Share a folder: confine fsGuard + (re)start the office sidecar on it. */
  async setFolder(folder: string): Promise<void> {
    this.guard.setRoots([folder]);
    try { await officeSidecar.ensure(folder); } catch (e: any) { console.error('sidecar start failed:', e?.message); }
    this.register();
    this.notify();
  }

  private register(): void {
    this.socket?.emit(EV.REGISTER, { folders: this.guard.folders });
  }

  private async handleToolCall(payload: any, ack?: (r: any) => void): Promise<void> {
    const { tool, args } = payload || {};
    const reply = typeof ack === 'function' ? ack : () => {};
    const record: Activity = { at: Date.now(), tool, path: args?.path, ok: false };
    try {
      if (this.guard.folders.length === 0) throw new GuardError('NO_FOLDER', 'No folder is shared in the desktop app.');
      let result: unknown;
      if (FS_TOOLS.has(tool)) {
        result = dispatchFsTool(this.guard, tool, args);     // allow-listed filesystem
      } else {
        // Office tools: the sidecar has OFFICE_ROOT = shared folder, so it
        // confines paths the same way fsGuard does. Pass args through.
        result = await officeSidecar.call(tool, args || {});
      }
      record.ok = true;
      reply({ ok: true, result });
    } catch (e: any) {
      const code = e instanceof GuardError ? e.code : 'EFAIL';
      record.error = e?.message || String(e);
      reply({ ok: false, code, error: record.error });
    } finally {
      this.activity.unshift(record);
      if (this.activity.length > 500) this.activity.length = 500;
      this.notify();
    }
  }

  async stop(): Promise<void> {
    this.socket?.disconnect();
    this.socket = null;
    await officeSidecar.stop();
  }
}

export const bridge = new Bridge();
