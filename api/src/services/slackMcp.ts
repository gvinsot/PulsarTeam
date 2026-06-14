import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSlackAccessTokenForAgent } from '../routes/slack.js';
import { createMcpHttpHandler } from './mcpHttpHandler.js';

const SLACK_BASE = 'https://slack.com/api';

/**
 * Slack methods that are read-only and must be issued as GET even when they
 * carry parameters. Other methods with params go out as POST with a JSON body;
 * any method called with zero params also stays GET (existing behavior).
 * NOTE: conversations.replies is intentionally NOT here — read_thread sends it
 * as POST with a JSON body, and moving it would change the wire request.
 */
const SLACK_GET_METHODS = new Set([
  'users.list',
  'conversations.list',
  'conversations.history',
  'conversations.info',
  'reactions.get',
]);

/**
 * Helper to call the Slack Web API.
 * Uses agent-specific tokens when agentId is provided.
 */
async function slackApi(method: string, agentId: string | null = null, boardId: string | null = null, params: Record<string, any> = {}) {
  const token = await getSlackAccessTokenForAgent(agentId, boardId);
  const isGet = SLACK_GET_METHODS.has(method) || Object.keys(params).length === 0;

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { signal: AbortSignal.timeout(60_000), headers };
  let url = `${SLACK_BASE}/${method}`;

  if (isGet) {
    // Append a query string whenever params is non-empty, matching the
    // original behavior (a bare '?' results when every value is null/undefined).
    if (Object.keys(params).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      url += `?${qs}`;
    }
  } else {
    init.method = 'POST';
    init.body = JSON.stringify(params);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }

  const res = await fetch(url, init);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}${data.needed ? ` (needs scope: ${data.needed})` : ''}`);
  }

  return data;
}

/**
 * Format a Slack message for display.
 */
function formatMessage(msg: any) {
  const ts = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '';
  const user = msg.user || msg.bot_id || 'unknown';
  const text = msg.text || '';
  const threadTs = msg.thread_ts || '';
  const replyCount = msg.reply_count || 0;

  return { ts: msg.ts, timestamp: ts, user, text, threadTs, replyCount };
}

/**
 * Create the Slack MCP server with all tools registered.
 * @param agentId - When provided, tools use agent-specific tokens.
 */
export function createSlackMcpServer(agentId = null, boardId = null) {
  const server = new McpServer({
    name: 'Slack',
    version: '1.0.0',
  });

  // ── Tool: list_channels ──────────────────────────────────────────────
  server.tool(
    'list_channels',
    'List Slack channels the bot has access to. Returns channel names, IDs, topics, and member counts.',
    {
      types: z.string().optional().default('public_channel').describe('Comma-separated channel types: public_channel, private_channel, mpim, im'),
      limit: z.number().optional().default(100).describe('Max channels to return (default 100, max 200)'),
    },
    async ({ types, limit }) => {
      const data = await slackApi('conversations.list', agentId, boardId, {
        types: types || 'public_channel',
        limit: Math.min(limit || 100, 200),
        exclude_archived: true,
      });

      const channels = data.channels || [];
      if (channels.length === 0) {
        return { content: [{ type: 'text', text: 'No channels found.' }] };
      }

      const summary = channels.map((ch, i) => {
        const prefix = ch.is_private ? '🔒' : '#';
        const members = ch.num_members || 0;
        const topic = ch.topic?.value ? ` — ${ch.topic.value.slice(0, 80)}` : '';
        return `${i + 1}. ${prefix} ${ch.name} (ID: ${ch.id}, ${members} members)${topic}`;
      }).join('\n');

      return {
        content: [{ type: 'text', text: `Found ${channels.length} channel(s):\n\n${summary}` }],
      };
    }
  );

  // ── Tool: read_channel ───────────────────────────────────────────────
  server.tool(
    'read_channel',
    'Read recent messages from a Slack channel. Returns messages with timestamps, users, and text.',
    {
      channel: z.string().describe('Channel ID (e.g. C01234ABCDE)'),
      limit: z.number().optional().default(20).describe('Number of messages to return (default 20, max 100)'),
    },
    async ({ channel, limit }) => {
      const count = Math.min(limit || 20, 100);
      const data = await slackApi('conversations.history', agentId, boardId, {
        channel,
        limit: count,
      });

      const messages = (data.messages || []).map(formatMessage);
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: 'No messages found in this channel.' }] };
      }

      const summary = messages.map((m, i) => {
        const thread = m.replyCount > 0 ? ` [${m.replyCount} replies]` : '';
        return `${i + 1}. [${m.timestamp}] <${m.user}>: ${m.text}${thread}\n   ts: ${m.ts}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: `Last ${messages.length} message(s) in <#${channel}>:\n\n${summary}` }],
      };
    }
  );

  // ── Tool: read_thread ────────────────────────────────────────────────
  server.tool(
    'read_thread',
    'Read all replies in a message thread.',
    {
      channel: z.string().describe('Channel ID'),
      thread_ts: z.string().describe('Thread timestamp (ts of the parent message)'),
      limit: z.number().optional().default(50).describe('Max replies (default 50, max 200)'),
    },
    async ({ channel, thread_ts, limit }) => {
      const count = Math.min(limit || 50, 200);
      const data = await slackApi('conversations.replies', agentId, boardId, {
        channel,
        ts: thread_ts,
        limit: count,
      });

      const messages = (data.messages || []).map(formatMessage);
      const summary = messages.map((m, i) => {
        return `${i + 1}. [${m.timestamp}] <${m.user}>: ${m.text}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: `Thread (${messages.length} message(s)):\n\n${summary}` }],
      };
    }
  );

  // ── Tool: send_message ───────────────────────────────────────────────
  server.tool(
    'send_message',
    'Send a message to a Slack channel or user. Supports plain text and mrkdwn formatting.',
    {
      channel: z.string().describe('Channel ID or user ID to send the message to'),
      text: z.string().describe('Message text (supports Slack mrkdwn formatting)'),
      thread_ts: z.string().optional().describe('Thread timestamp to reply in a thread'),
    },
    async ({ channel, text, thread_ts }) => {
      const params: any = { channel, text };
      if (thread_ts) params.thread_ts = thread_ts;

      const data = await slackApi('chat.postMessage', agentId, boardId, params);

      return {
        content: [{
          type: 'text',
          text: `Message sent to <#${channel}>!\nTimestamp: ${data.ts}\n${thread_ts ? `Thread: ${thread_ts}` : 'New message'}`
        }],
      };
    }
  );

  // ── Tool: reply_to_message ───────────────────────────────────────────
  server.tool(
    'reply_to_message',
    'Reply to a specific message in a thread.',
    {
      channel: z.string().describe('Channel ID'),
      thread_ts: z.string().describe('Timestamp of the message to reply to'),
      text: z.string().describe('Reply text'),
    },
    async ({ channel, thread_ts, text }) => {
      const data = await slackApi('chat.postMessage', agentId, boardId, {
        channel,
        text,
        thread_ts,
      });

      return {
        content: [{
          type: 'text',
          text: `Reply sent in thread ${thread_ts}!\nTimestamp: ${data.ts}`
        }],
      };
    }
  );

  // ── Tool: list_users ─────────────────────────────────────────────────
  server.tool(
    'list_users',
    'List workspace members. Returns display names, real names, and status.',
    {
      limit: z.number().optional().default(100).describe('Max users to return (default 100)'),
    },
    async ({ limit }) => {
      const data = await slackApi('users.list', agentId, boardId, {
        limit: Math.min(limit || 100, 200),
      });

      const members = (data.members || []).filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT');
      if (members.length === 0) {
        return { content: [{ type: 'text', text: 'No users found.' }] };
      }

      const summary = members.map((u, i) => {
        const name = u.profile?.display_name || u.profile?.real_name || u.name;
        const status = u.profile?.status_text ? ` — "${u.profile.status_text}"` : '';
        const admin = u.is_admin ? ' [admin]' : '';
        return `${i + 1}. ${name} (ID: ${u.id})${admin}${status}`;
      }).join('\n');

      return {
        content: [{ type: 'text', text: `${members.length} workspace member(s):\n\n${summary}` }],
      };
    }
  );

  // ── Tool: search_messages ────────────────────────────────────────────
  server.tool(
    'search_messages',
    'Search for messages across the workspace. Requires a query string.',
    {
      query: z.string().describe('Search query (supports Slack search operators: in:#channel, from:@user, etc.)'),
      count: z.number().optional().default(20).describe('Number of results (default 20, max 100)'),
    },
    async ({ query, count }) => {
      // search.messages requires a user token, but we try with bot token
      // If it fails, we'll provide a clear error
      try {
        const data = await slackApi('search.messages', agentId, boardId, {
          query,
          count: Math.min(count || 20, 100),
          sort: 'timestamp',
          sort_dir: 'desc',
        });

        const matches = data.messages?.matches || [];
        if (matches.length === 0) {
          return { content: [{ type: 'text', text: `No messages found for query: "${query}"` }] };
        }

        const summary = matches.map((m, i) => {
          const ts = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : '';
          const channel = m.channel?.name ? `#${m.channel.name}` : '';
          return `${i + 1}. [${ts}] ${channel} <${m.user || m.username || 'unknown'}>: ${(m.text || '').slice(0, 200)}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `Found ${data.messages.total} result(s) for "${query}":\n\n${summary}`
          }],
        };
      } catch (err: any) {
        if (err.message?.includes('missing_scope') || err.message?.includes('not_allowed')) {
          return {
            content: [{
              type: 'text',
              text: `Search is not available with the current bot token scopes. To search messages, the Slack app needs the "search:read" user scope. Use read_channel to browse specific channels instead.`
            }],
          };
        }
        throw err;
      }
    }
  );

  // ── Tool: get_channel_info ───────────────────────────────────────────
  server.tool(
    'get_channel_info',
    'Get detailed information about a Slack channel.',
    {
      channel: z.string().describe('Channel ID'),
    },
    async ({ channel }) => {
      const data = await slackApi('conversations.info', agentId, boardId, { channel });
      const ch = data.channel;

      const info = [
        `Name: #${ch.name}`,
        `ID: ${ch.id}`,
        `Type: ${ch.is_private ? 'Private' : 'Public'} channel`,
        `Members: ${ch.num_members || 'unknown'}`,
        `Topic: ${ch.topic?.value || '(none)'}`,
        `Purpose: ${ch.purpose?.value || '(none)'}`,
        `Created: ${new Date(ch.created * 1000).toISOString()}`,
        `Archived: ${ch.is_archived ? 'Yes' : 'No'}`,
      ];

      return {
        content: [{ type: 'text', text: info.join('\n') }],
      };
    }
  );

  // ── Tool: add_reaction ───────────────────────────────────────────────
  server.tool(
    'add_reaction',
    'Add an emoji reaction to a message.',
    {
      channel: z.string().describe('Channel ID'),
      timestamp: z.string().describe('Message timestamp (ts)'),
      name: z.string().describe('Emoji name without colons (e.g. "thumbsup", "eyes", "white_check_mark")'),
    },
    async ({ channel, timestamp, name }) => {
      await slackApi('reactions.add', agentId, boardId, {
        channel,
        timestamp,
        name,
      });

      return {
        content: [{ type: 'text', text: `Reaction :${name}: added to message ${timestamp}` }],
      };
    }
  );

  // ── Tool: open_dm ────────────────────────────────────────────────────
  server.tool(
    'open_dm',
    'Open a direct message channel with a user. Returns the DM channel ID for sending messages.',
    {
      user: z.string().describe('User ID to open DM with'),
    },
    async ({ user }) => {
      const data = await slackApi('conversations.open', agentId, boardId, {
        users: user,
      });

      return {
        content: [{
          type: 'text',
          text: `DM channel opened!\nChannel ID: ${data.channel?.id}\nUse this channel ID to send direct messages.`
        }],
      };
    }
  );

  return server;
}

/**
 * Create an Express handler for the Slack MCP endpoint.
 * Reads X-Agent-Id header to provide agent-specific token resolution.
 */
export function createSlackMcpHandler() {
  return createMcpHttpHandler('Slack', ({ agentId, boardId }) =>
    createSlackMcpServer(agentId, boardId));
}
