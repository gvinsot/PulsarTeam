/**
 * How the terminal proxy dials a runner-service PTY socket.
 *
 * Split out of routes/terminal.ts because the *shape* of this handshake is a
 * security property, not a formatting detail: the shared `CODER_API_KEY` used
 * to travel as `?api_key=…` on the URL, and uvicorn logs a WebSocket
 * handshake target verbatim — so every terminal attach printed the runner key
 * in clear into the runner's logs (and anything shipping them off the node).
 *
 * The key now travels in the `Authorization: Bearer` header. That costs
 * nothing here: this dial is server→server (Node `ws` client), so unlike the
 * browser's WebSocket API it can set request headers. Runners have always
 * accepted the header, so a new proxy talks to an old runner unchanged; the
 * runner still accepts the query parameter for the reverse case.
 */

export interface RunnerTerminalDial {
  /** Absolute ws:// or wss:// URL — carries no credential. */
  url: string;
  /** Request headers for the `ws` client, including the bearer credential. */
  headers: Record<string, string>;
}

export interface RunnerTerminalDialOptions {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  ownerId?: string | null;
  cols: string | number;
  rows: string | number;
  /** Extra runner context headers (agent permissions, LLM config overrides). */
  headers?: Record<string, string>;
}

export function buildRunnerTerminalDial({
  baseUrl,
  agentId,
  apiKey,
  ownerId,
  cols,
  rows,
  headers = {},
}: RunnerTerminalDialOptions): RunnerTerminalDial {
  const url =
    baseUrl.replace(/^http/, 'ws') +
    `/ws/terminal/${encodeURIComponent(agentId)}` +
    `?cols=${encodeURIComponent(String(cols))}&rows=${encodeURIComponent(String(rows))}` +
    (ownerId ? `&owner_id=${encodeURIComponent(ownerId)}` : '');

  return {
    url,
    headers: { ...headers, Authorization: `Bearer ${apiKey}` },
  };
}
