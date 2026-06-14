import { createJsonDocStore } from './jsonDocStore.js';

const store = createJsonDocStore('mcp_servers', {
  secretFields: ['apiKey'],
  label: 'MCP server',
  labelPlural: 'MCP servers',
});

export const getAllMcpServers = store.getAll;
export const saveMcpServer = store.save;
export const deleteMcpServerFromDb = store.remove;
