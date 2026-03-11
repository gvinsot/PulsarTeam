export const BUILTIN_MCP_SERVERS = [
  {
    id: 'mcp-swarm-manager',
    name: 'Swarm Manager',
    url: process.env.MCP_ENDPOINT || 'http://swarm-manager:8000/ai/mcp',
    description: 'Docker Swarm deployment — build, deploy, monitor stacks',
    icon: '🐝',
    apiKey: '',
    builtin: true,
    enabled: true,
  },
  {
    id: 'mcp-onedrive',
    name: 'OneDrive',
    url: '__internal__onedrive',
    description: 'Microsoft OneDrive — browse, search, read, upload, and manage files via Microsoft Graph',
    icon: '☁️',
    apiKey: '',
    builtin: true,
    enabled: true,
  },
  {
    id: 'mcp-code-index',
    name: 'Code Index',
    url: '__internal__code_index',
    description: 'Local code indexing, symbol lookup, file outlines, and semantic code search',
    icon: '🧠',
    apiKey: '',
    builtin: true,
    enabled: true,
  }
];