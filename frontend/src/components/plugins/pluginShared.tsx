import { X } from 'lucide-react';
import OneDriveConnect from '../OneDriveConnect';
import OutlookConnect from '../OutlookConnect';
import GmailConnect from '../GmailConnect';
import GoogleDriveConnect from '../GoogleDriveConnect';
import SlackConnect from '../SlackConnect';
import JiraConnect from '../JiraConnect';
import WordPressConnect from '../WordPressConnect';
import GitHubConnect from '../GitHubConnect';
import S3Connect from '../S3Connect';
import LocalFolderConnect from '../LocalFolderConnect';

// Map MCP server IDs to their dedicated OAuth/API-key connector widget.
// Returning null means the MCP doesn't need an interactive connector here
// (it's wired via global env vars or doesn't expose a setup UI).
export const MCP_CONNECTOR_MAP: Record<string, any> = {
  'mcp-onedrive': OneDriveConnect,
  'mcp-gmail': GmailConnect,
  'mcp-outlook': OutlookConnect,
  'mcp-gdrive': GoogleDriveConnect,
  'mcp-slack': SlackConnect,
  'mcp-jira': JiraConnect,
  'mcp-wordpress': WordPressConnect,
  'mcp-github': GitHubConnect,
  'mcp-aws-s3': S3Connect,
  'mcp-local-folder': LocalFolderConnect,
};

export function getPluginMcpIds(plugin: any): string[] {
  const ids = new Set<string>();
  for (const m of plugin.mcps || []) {
    if (m?.id) ids.add(m.id);
  }
  for (const id of plugin.mcpServerIds || []) {
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

const categoryColors = {
  coding: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  devops: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  writing: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  security: 'bg-red-500/20 text-red-400 border-red-500/30',
  analysis: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  general: 'bg-dark-500/20 text-dark-300 border-dark-500/30',
};

export const getCategoryClass = (cat) => categoryColors[cat] || categoryColors.general;

// Category filter pill row shared by the agent + board plugin surfaces.
export function CategoryFilterPills({ categories, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {categories.map(cat => (
        <button
          key={cat}
          onClick={() => onChange(cat)}
          className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors border ${
            value === cat
              ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
              : 'bg-dark-800 text-dark-400 border-dark-700 hover:text-dark-200'
          }`}
        >
          {cat === 'all' ? 'All' : cat}
        </button>
      ))}
    </div>
  );
}

// Assigned-plugin card with embedded MCP connector widgets.
// `badges` renders between the category badge and the MCP-count badge;
// `extraActions` renders before the remove button; `connectorProps` is
// spread onto each connector widget ({agentId|boardId, onStatusChange}).
export function AssignedPluginCard({ plugin, badges, extraActions, onRemove, connectorProps }: {
  plugin: any;
  badges?: any;
  extraActions?: any;
  onRemove: () => void;
  connectorProps: Record<string, any>;
}) {
  const pluginMcps = (plugin.mcps || []).filter(m => m.id);
  const connectorMcpIds = getPluginMcpIds(plugin).filter(id => MCP_CONNECTOR_MAP[id]);
  return (
    <div className="bg-dark-800/50 rounded-lg border border-dark-700/50">
      <div className="flex items-center gap-3 p-3 group">
        <span className="text-lg flex-shrink-0">{plugin.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-dark-200">{plugin.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
              {plugin.category}
            </span>
            {badges}
            {pluginMcps.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                {pluginMcps.length} MCP
              </span>
            )}
          </div>
          <p className="text-xs text-dark-400 truncate">{plugin.description}</p>
        </div>
        {extraActions}
        <button
          onClick={onRemove}
          className="p-1 text-dark-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
          title="Remove plugin"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {connectorMcpIds.length > 0 && (
        <div className="px-3 pb-3 space-y-2">
          {connectorMcpIds.map(mcpId => {
            const Connector = MCP_CONNECTOR_MAP[mcpId];
            return (
              <Connector
                key={mcpId}
                {...connectorProps}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// Available-plugin row. Badge slots keep DOM order configurable:
// `beforeMcpBadges` renders between the category badge and the MCP-count
// badge, `afterMcpBadges` after it.
export function AvailablePluginRow({ plugin, beforeMcpBadges, afterMcpBadges, onAdd, addLabel = 'Add' }: {
  plugin: any;
  beforeMcpBadges?: any;
  afterMcpBadges?: any;
  onAdd: () => void;
  addLabel?: any;
}) {
  return (
    <div className="flex items-center gap-3 p-3 bg-dark-800/30 rounded-lg border border-dark-700/30 hover:border-dark-600 transition-colors group">
      <span className="text-lg flex-shrink-0">{plugin.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-dark-300">{plugin.name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
            {plugin.category}
          </span>
          {beforeMcpBadges}
          {(plugin.mcps || []).length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
              {(plugin.mcps || []).length} MCP
            </span>
          )}
          {afterMcpBadges}
        </div>
        <p className="text-xs text-dark-500 truncate">{plugin.description}</p>
      </div>
      <button
        onClick={onAdd}
        className="px-2.5 py-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 rounded-md text-xs font-medium transition-colors flex-shrink-0 flex items-center gap-1"
      >
        {addLabel}
      </button>
    </div>
  );
}
