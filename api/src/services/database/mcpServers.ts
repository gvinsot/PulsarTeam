import { createJsonDocStore } from './jsonDocStore.js';
import type { McpServerEntry } from '../mcpManager.js';

const store = createJsonDocStore<McpServerEntry>('mcp_servers', {
  secretFields: ['apiKey'],
  label: 'MCP server',
  labelPlural: 'MCP servers',
});

export const getAllMcpServers = store.getAll;
export const saveMcpServer = store.save;
export const deleteMcpServerFromDb = store.remove;
