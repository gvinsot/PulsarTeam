import { z } from 'zod';

/**
 * Shared MCP response-envelope helpers.
 *
 * Every MCP tool must return the `{ content: [{ type: 'text', text }] }` shape
 * defined by the Model Context Protocol. Before this module each provider
 * hand-built that literal (~98 times) and `jsonOk`/`jsonError` were copy-pasted
 * byte-for-byte between swarmApiMcp and pulsarGatewayMcp. Centralising them here
 * gives every current and future MCP provider one place to build responses.
 */

/** Plain text envelope: wraps a string in the MCP text-content shape. */
export const text = (s: string) => ({
  content: [{ type: 'text' as const, text: s }],
});

/** Success envelope: pretty-printed JSON text content. */
export const jsonOk = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
});

/** Error envelope: compact `{ error }` JSON text content flagged isError. */
export const jsonError = (error: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

/**
 * Fields shared by the two `update_task` tools (swarmApiMcp exposes it to the
 * Swarm API surface with an explicit task_id + agent selector; pulsarGatewayMcp
 * exposes it to CLI runner agents where the task is auto-detected). Spread this
 * into each tool's zod shape and add the file-specific fields (task_id /
 * agent_id / agent_name) alongside.
 */
export const taskMutationSharedShape = {
  status: z
    .string()
    .optional()
    .describe(
      'Target column — workflow column label preferred (e.g. "In Review", "Done"); the column id is also accepted.',
    ),
  comment: z
    .string()
    .optional()
    .describe(
      'Completion summary appended onto the task card so the requester sees what was done. Providing it marks the task finished (commit and push your code first).',
    ),
  commits: z
    .string()
    .optional()
    .describe(
      'Optional already-pushed commits to link, comma-separated "hash:message, hash:message". Pushed commits are auto-linked even if omitted.',
    ),
  done: z
    .boolean()
    .optional()
    .describe(
      'Set true to signal the task is finished when you have no status change or comment to add (rarely needed — a status move or comment already finishes it).',
    ),
  repo_full_name: z
    .string()
    .optional()
    .describe('New repository in "owner/repo" format. Empty string clears the binding.'),
  repo_provider: z
    .string()
    .optional()
    .describe('Repository provider — defaults to "github" when repo_full_name is set.'),
  storage_path: z
    .string()
    .optional()
    .describe('New storage location (e.g. OneDrive folder path). Empty string clears the binding.'),
  storage_provider: z
    .string()
    .optional()
    .describe('Storage provider — defaults to "onedrive" when storage_path is set.'),
};
