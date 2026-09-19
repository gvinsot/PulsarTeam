/** Existing scoped HTTP surfaces, reached locally with the user's API key. */
export const PULSAR_TEAM_MCP_SERVERS = [
  {
    scope: 'admin',
    label: 'Admin',
    icon: '⚙️',
    description: 'Configure agents, boards, projects, workflows and shares.',
  },
  {
    scope: 'management',
    label: 'Management',
    icon: '👥',
    description: 'Create, delegate, run, track and manage tasks and recurring rules.',
  },
  {
    scope: 'insert',
    label: 'Insert',
    icon: '📥',
    description: 'Create tasks on the single board bound to an insert API key.',
  },
].map(({ scope, label, icon, description }) => ({
  id: `mcp-pulsar-team-${scope}`,
  name: `PulsarTeam ${label}`,
  url: `http://127.0.0.1:${process.env.PORT || 3001}/api/mcp/${scope}`,
  description,
  icon,
  apiKey: '',
  remoteAuth: 'api_key' as const,
  builtin: true,
  enabled: true,
}));
