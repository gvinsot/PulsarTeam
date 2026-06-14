import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getWordPressCredentialsForAgent } from '../routes/wordpress.js';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import { createProviderFetch } from './providerFetch.js';

/**
 * Minimal MIME type lookup for media uploads. WordPress is fairly strict
 * about Content-Type so we send a sensible value rather than octet-stream.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

function guessMimeType(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// JSON Content-Type is only set when the caller didn't already provide one
// (media uploads send their own binary Content-Type) — see 'onlyStringBody'.
const wpProviderFetch = createProviderFetch({
  errorLabel: 'WordPress API error',
  getAuth: (agentId, boardId) => {
    const creds = getWordPressCredentialsForAgent(agentId, boardId);
    if (!creds) throw new Error('Not connected to WordPress. Please configure WordPress credentials for this agent or board first.');
    return {
      authorization: `Basic ${Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString('base64')}`,
      base: `${creds.siteUrl}/wp-json`,
    };
  },
  defaultHeaders: { Accept: 'application/json' },
  contentType: 'onlyStringBody',
  nullStatuses: [204],
  parse: 'json',
  maxErrorChars: 400,
});

/**
 * Call the WordPress REST API with per-agent/board Application Password credentials.
 */
async function wpFetch(
  agentId: string | null,
  boardId: string | null,
  endpoint: string,
  options: Record<string, any> = {},
): Promise<any> {
  // Normalize the leading slash so "wp/v2/posts" and "/wp/v2/posts" both work.
  const path = endpoint.startsWith('http')
    ? endpoint
    : `${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  return wpProviderFetch(path, agentId, boardId, options);
}

/**
 * Resolve a list of slug-or-name terms to numeric IDs in WP, creating them on demand
 * for taxonomies that allow it (categories, tags). Used so the agent can pass either
 * names or IDs without first looking them up.
 */
async function resolveTermIds(
  agentId: string | null,
  boardId: string | null,
  taxonomy: 'categories' | 'tags',
  terms: string[] | undefined,
): Promise<number[]> {
  if (!terms || terms.length === 0) return [];
  const ids: number[] = [];
  for (const raw of terms) {
    const term = String(raw).trim();
    if (!term) continue;
    if (/^\d+$/.test(term)) { ids.push(parseInt(term, 10)); continue; }
    const matches = await wpFetch(
      agentId, boardId,
      `/wp/v2/${taxonomy}?search=${encodeURIComponent(term)}&per_page=10`,
    );
    const exact = (Array.isArray(matches) ? matches : []).find((t: any) =>
      t.name?.toLowerCase() === term.toLowerCase() || t.slug?.toLowerCase() === term.toLowerCase()
    );
    if (exact) { ids.push(exact.id); continue; }
    // Create it
    const created = await wpFetch(agentId, boardId, `/wp/v2/${taxonomy}`, {
      method: 'POST',
      body: JSON.stringify({ name: term }),
    });
    if (created?.id) ids.push(created.id);
  }
  return ids;
}

const postStatusEnum = z.enum(['publish', 'draft', 'pending', 'private', 'future']);

/**
 * Create the WordPress MCP server with all tools registered.
 */
export function createWordPressMcpServer(agentId: string | null = null, pulsarBoardId: string | null = null) {
  const server = new McpServer({
    name: 'WordPress',
    version: '1.0.0',
  });

  // ── Tool: get_site_info ──────────────────────────────────────────────
  server.tool(
    'get_site_info',
    'Get information about the connected WordPress site (name, description, URL, supported features).',
    {},
    async () => {
      const info = await wpFetch(agentId, pulsarBoardId, '/');
      return {
        content: [{
          type: 'text',
          text: [
            `Site: ${info.name || '?'}`,
            `Description: ${info.description || '(none)'}`,
            `URL: ${info.url || '?'}`,
            `Home: ${info.home || '?'}`,
            `Timezone: ${info.timezone_string || '?'}`,
            `Namespaces: ${(info.namespaces || []).join(', ')}`,
          ].join('\n'),
        }],
      };
    }
  );

  // ── Tool: get_myself ─────────────────────────────────────────────────
  server.tool(
    'get_myself',
    'Get the current authenticated WordPress user profile.',
    {},
    async () => {
      const user = await wpFetch(agentId, pulsarBoardId, '/wp/v2/users/me?context=edit');
      return {
        content: [{
          type: 'text',
          text: `WordPress User:\nID: ${user.id}\nName: ${user.name}\nUsername: ${user.username || user.slug}\nEmail: ${user.email || '?'}\nRoles: ${(user.roles || []).join(', ')}`,
        }],
      };
    }
  );

  // ── Tool: list_posts ─────────────────────────────────────────────────
  server.tool(
    'list_posts',
    'List WordPress posts with optional filters (status, search, author, category, tag).',
    {
      status: z.string().optional().describe('Filter by status (publish, draft, pending, private, future, any). Default: publish'),
      search: z.string().optional().describe('Search term'),
      author: z.number().optional().describe('Filter by author user ID'),
      category: z.string().optional().describe('Category name, slug, or numeric ID'),
      tag: z.string().optional().describe('Tag name, slug, or numeric ID'),
      perPage: z.number().optional().default(20).describe('Results per page (1-100, default 20)'),
      page: z.number().optional().default(1).describe('Page number (default 1)'),
    },
    async ({ status, search, author, category, tag, perPage, page }) => {
      const params = new URLSearchParams();
      params.set('per_page', String(Math.min(Math.max(perPage || 20, 1), 100)));
      params.set('page', String(Math.max(page || 1, 1)));
      if (status) params.set('status', status);
      if (search) params.set('search', search);
      if (author) params.set('author', String(author));
      if (category) {
        const ids = await resolveTermIds(agentId, pulsarBoardId, 'categories', [category]);
        if (ids.length) params.set('categories', ids.join(','));
      }
      if (tag) {
        const ids = await resolveTermIds(agentId, pulsarBoardId, 'tags', [tag]);
        if (ids.length) params.set('tags', ids.join(','));
      }
      const posts = await wpFetch(agentId, pulsarBoardId, `/wp/v2/posts?${params.toString()}&context=edit`);
      const list = (Array.isArray(posts) ? posts : []).map((p: any) =>
        `- [${p.id}] "${p.title?.rendered || p.title?.raw || '(untitled)'}" [${p.status}] — ${p.link}`
      ).join('\n');
      return {
        content: [{ type: 'text', text: `WordPress Posts (${Array.isArray(posts) ? posts.length : 0}):\n${list || '(none)'}` }],
      };
    }
  );

  // ── Tool: get_post ───────────────────────────────────────────────────
  server.tool(
    'get_post',
    'Get the full content of a WordPress post by ID.',
    {
      postId: z.number().describe('The post ID'),
    },
    async ({ postId }) => {
      const p = await wpFetch(agentId, pulsarBoardId, `/wp/v2/posts/${postId}?context=edit`);
      return {
        content: [{
          type: 'text',
          text: [
            `Post: [${p.id}] ${p.title?.rendered || p.title?.raw || '(untitled)'}`,
            `Status: ${p.status} | Slug: ${p.slug} | Author: ${p.author}`,
            `Date: ${p.date} | Modified: ${p.modified}`,
            `URL: ${p.link}`,
            `Categories: ${(p.categories || []).join(', ') || 'none'}`,
            `Tags: ${(p.tags || []).join(', ') || 'none'}`,
            `Featured media: ${p.featured_media || 'none'}`,
            `\n--- Excerpt ---\n${p.excerpt?.raw || p.excerpt?.rendered || '(none)'}`,
            `\n--- Content ---\n${p.content?.raw || p.content?.rendered || '(empty)'}`,
          ].join('\n'),
        }],
      };
    }
  );

  // ── Tool: create_post ────────────────────────────────────────────────
  server.tool(
    'create_post',
    'Create a new WordPress post. Use status="publish" to publish immediately, "draft" (default) to save as a draft, or "future" with a date to schedule.',
    {
      title: z.string().describe('Post title'),
      content: z.string().describe('Post content (HTML or block markup). Plain text and basic HTML are both fine.'),
      status: postStatusEnum.optional().default('draft').describe('Post status (default: draft)'),
      excerpt: z.string().optional().describe('Short excerpt'),
      slug: z.string().optional().describe('URL slug'),
      categories: z.array(z.string()).optional().describe('Category names, slugs, or IDs (created automatically if missing)'),
      tags: z.array(z.string()).optional().describe('Tag names, slugs, or IDs (created automatically if missing)'),
      featuredMediaId: z.number().optional().describe('Featured image: WordPress media ID (use upload_media first)'),
      date: z.string().optional().describe('Publish date as ISO 8601 string (only relevant for status=future)'),
    },
    async ({ title, content, status, excerpt, slug, categories, tags, featuredMediaId, date }) => {
      const body: any = {
        title,
        content,
        status: status || 'draft',
      };
      if (excerpt) body.excerpt = excerpt;
      if (slug) body.slug = slug;
      if (featuredMediaId) body.featured_media = featuredMediaId;
      if (date) body.date = date;
      if (categories?.length) body.categories = await resolveTermIds(agentId, pulsarBoardId, 'categories', categories);
      if (tags?.length) body.tags = await resolveTermIds(agentId, pulsarBoardId, 'tags', tags);

      const created = await wpFetch(agentId, pulsarBoardId, '/wp/v2/posts', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        content: [{
          type: 'text',
          text: `Post created: [${created.id}] "${created.title?.rendered || title}" [${created.status}]\nURL: ${created.link}`,
        }],
      };
    }
  );

  // ── Tool: update_post ────────────────────────────────────────────────
  server.tool(
    'update_post',
    'Update fields of an existing WordPress post (title, content, status, excerpt, slug, categories, tags, featured image).',
    {
      postId: z.number().describe('The post ID to update'),
      title: z.string().optional().describe('New title'),
      content: z.string().optional().describe('New content'),
      status: postStatusEnum.optional().describe('New status'),
      excerpt: z.string().optional().describe('New excerpt'),
      slug: z.string().optional().describe('New URL slug'),
      categories: z.array(z.string()).optional().describe('New categories (replaces existing)'),
      tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
      featuredMediaId: z.number().optional().describe('Featured image media ID (use 0 to clear)'),
      date: z.string().optional().describe('New publish date as ISO 8601'),
    },
    async ({ postId, title, content, status, excerpt, slug, categories, tags, featuredMediaId, date }) => {
      const body: any = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (status !== undefined) body.status = status;
      if (excerpt !== undefined) body.excerpt = excerpt;
      if (slug !== undefined) body.slug = slug;
      if (featuredMediaId !== undefined) body.featured_media = featuredMediaId;
      if (date !== undefined) body.date = date;
      if (categories !== undefined) body.categories = await resolveTermIds(agentId, pulsarBoardId, 'categories', categories);
      if (tags !== undefined) body.tags = await resolveTermIds(agentId, pulsarBoardId, 'tags', tags);

      if (Object.keys(body).length === 0) {
        return { content: [{ type: 'text', text: 'No fields supplied to update.' }] };
      }

      const updated = await wpFetch(agentId, pulsarBoardId, `/wp/v2/posts/${postId}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        content: [{
          type: 'text',
          text: `Post updated: [${updated.id}] "${updated.title?.rendered || ''}" [${updated.status}]\nURL: ${updated.link}`,
        }],
      };
    }
  );

  // ── Tool: publish_post ───────────────────────────────────────────────
  server.tool(
    'publish_post',
    'Publish an existing draft/pending/scheduled post by setting its status to "publish". Convenience wrapper around update_post.',
    {
      postId: z.number().describe('The post ID to publish'),
    },
    async ({ postId }) => {
      const updated = await wpFetch(agentId, pulsarBoardId, `/wp/v2/posts/${postId}`, {
        method: 'POST',
        body: JSON.stringify({ status: 'publish' }),
      });
      return {
        content: [{
          type: 'text',
          text: `Post published: [${updated.id}] "${updated.title?.rendered || ''}"\nURL: ${updated.link}`,
        }],
      };
    }
  );

  // ── Tool: delete_post ────────────────────────────────────────────────
  server.tool(
    'delete_post',
    'Delete a WordPress post. By default moves to Trash; pass force=true to delete permanently.',
    {
      postId: z.number().describe('The post ID to delete'),
      force: z.boolean().optional().default(false).describe('Permanently delete (true) or trash (false, default)'),
    },
    async ({ postId, force }) => {
      const result = await wpFetch(
        agentId, pulsarBoardId,
        `/wp/v2/posts/${postId}${force ? '?force=true' : ''}`,
        { method: 'DELETE' },
      );
      const wasTrashed = !force;
      return {
        content: [{
          type: 'text',
          text: wasTrashed
            ? `Post ${postId} moved to trash.`
            : `Post ${postId} permanently deleted.${result?.deleted ? '' : ''}`,
        }],
      };
    }
  );

  // ── Tool: list_pages ─────────────────────────────────────────────────
  server.tool(
    'list_pages',
    'List WordPress pages.',
    {
      status: z.string().optional().describe('Filter by status (default: publish)'),
      perPage: z.number().optional().default(20),
    },
    async ({ status, perPage }) => {
      const params = new URLSearchParams();
      params.set('per_page', String(Math.min(Math.max(perPage || 20, 1), 100)));
      if (status) params.set('status', status);
      const pages = await wpFetch(agentId, pulsarBoardId, `/wp/v2/pages?${params.toString()}&context=edit`);
      const list = (Array.isArray(pages) ? pages : []).map((p: any) =>
        `- [${p.id}] "${p.title?.rendered || '(untitled)'}" [${p.status}] — ${p.link}`
      ).join('\n');
      return { content: [{ type: 'text', text: `WordPress Pages (${Array.isArray(pages) ? pages.length : 0}):\n${list || '(none)'}` }] };
    }
  );

  // ── Tool: create_page ────────────────────────────────────────────────
  server.tool(
    'create_page',
    'Create a new WordPress page.',
    {
      title: z.string().describe('Page title'),
      content: z.string().describe('Page content (HTML)'),
      status: postStatusEnum.optional().default('draft'),
      slug: z.string().optional(),
      parentId: z.number().optional().describe('Parent page ID for nested pages'),
    },
    async ({ title, content, status, slug, parentId }) => {
      const body: any = { title, content, status: status || 'draft' };
      if (slug) body.slug = slug;
      if (parentId) body.parent = parentId;
      const created = await wpFetch(agentId, pulsarBoardId, '/wp/v2/pages', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        content: [{
          type: 'text',
          text: `Page created: [${created.id}] "${created.title?.rendered || title}" [${created.status}]\nURL: ${created.link}`,
        }],
      };
    }
  );

  // ── Tool: upload_media ───────────────────────────────────────────────
  server.tool(
    'upload_media',
    'Upload a file (image, PDF, video, etc.) from disk to the WordPress media library. Returns the new media ID, which can be passed as featuredMediaId to create_post.',
    {
      filePath: z.string().describe('Absolute or workspace-relative path to a file on this server'),
      filename: z.string().optional().describe('Optional filename to send (default: basename of filePath)'),
      mimeType: z.string().optional().describe('Optional MIME type (default: inferred from extension)'),
      title: z.string().optional().describe('Optional media title (default: filename)'),
      altText: z.string().optional().describe('Optional alternative text (for images)'),
      caption: z.string().optional().describe('Optional caption'),
    },
    async ({ filePath, filename, mimeType, title, altText, caption }) => {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        throw new Error(`Media upload failed: "${filePath}" is not a regular file`);
      }
      // WordPress default upload limit is typically 64 MB; cap at 50 MB to leave headroom.
      const MAX_BYTES = 50 * 1024 * 1024;
      if (stat.size > MAX_BYTES) {
        throw new Error(`Media file "${filePath}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, exceeds 50 MB cap`);
      }

      const buf = await fs.readFile(filePath);
      const finalName = filename || path.basename(filePath);
      const finalMime = mimeType || guessMimeType(filePath);

      const creds = getWordPressCredentialsForAgent(agentId, pulsarBoardId);
      if (!creds) throw new Error('Not connected to WordPress.');
      const encoded = Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString('base64');

      const uploadRes = await fetch(`${creds.siteUrl}/wp-json/wp/v2/media`, {
        signal: AbortSignal.timeout(120_000),
        method: 'POST',
        headers: {
          Authorization: `Basic ${encoded}`,
          'Content-Type': finalMime,
          'Content-Disposition': `attachment; filename="${finalName.replace(/"/g, '\\"')}"`,
          Accept: 'application/json',
        },
        body: buf,
      });

      if (!uploadRes.ok) {
        const txt = await uploadRes.text().catch(() => '');
        throw new Error(`WordPress media upload failed (${uploadRes.status}): ${txt.slice(0, 300)}`);
      }
      const media = await uploadRes.json();

      // Set optional metadata via follow-up PATCH-style POST (WP REST uses POST for updates)
      if (title || altText || caption) {
        const metaBody: any = {};
        if (title) metaBody.title = title;
        if (altText) metaBody.alt_text = altText;
        if (caption) metaBody.caption = caption;
        await wpFetch(agentId, pulsarBoardId, `/wp/v2/media/${media.id}`, {
          method: 'POST',
          body: JSON.stringify(metaBody),
        }).catch((err) => {
          // Non-fatal: the upload succeeded.
          console.warn(`[WordPress MCP] Media ${media.id} metadata update failed:`, err.message);
        });
      }

      return {
        content: [{
          type: 'text',
          text: `Media uploaded: [${media.id}] "${finalName}" (${(stat.size / 1024).toFixed(1)} KB, ${finalMime})\nURL: ${media.source_url || media.guid?.rendered || '?'}\nUse featuredMediaId=${media.id} on create_post/update_post to set as featured image.`,
        }],
      };
    }
  );

  // ── Tool: list_categories ────────────────────────────────────────────
  server.tool(
    'list_categories',
    'List WordPress categories.',
    {
      search: z.string().optional().describe('Search term'),
      perPage: z.number().optional().default(50),
    },
    async ({ search, perPage }) => {
      const params = new URLSearchParams();
      params.set('per_page', String(Math.min(Math.max(perPage || 50, 1), 100)));
      if (search) params.set('search', search);
      const cats = await wpFetch(agentId, pulsarBoardId, `/wp/v2/categories?${params.toString()}`);
      const list = (Array.isArray(cats) ? cats : []).map((c: any) =>
        `- [${c.id}] "${c.name}" (slug: ${c.slug}) — ${c.count} posts`
      ).join('\n');
      return { content: [{ type: 'text', text: `WordPress Categories (${Array.isArray(cats) ? cats.length : 0}):\n${list || '(none)'}` }] };
    }
  );

  // ── Tool: list_tags ──────────────────────────────────────────────────
  server.tool(
    'list_tags',
    'List WordPress tags.',
    {
      search: z.string().optional().describe('Search term'),
      perPage: z.number().optional().default(50),
    },
    async ({ search, perPage }) => {
      const params = new URLSearchParams();
      params.set('per_page', String(Math.min(Math.max(perPage || 50, 1), 100)));
      if (search) params.set('search', search);
      const tags = await wpFetch(agentId, pulsarBoardId, `/wp/v2/tags?${params.toString()}`);
      const list = (Array.isArray(tags) ? tags : []).map((t: any) =>
        `- [${t.id}] "${t.name}" (slug: ${t.slug}) — ${t.count} posts`
      ).join('\n');
      return { content: [{ type: 'text', text: `WordPress Tags (${Array.isArray(tags) ? tags.length : 0}):\n${list || '(none)'}` }] };
    }
  );

  return server;
}

/**
 * Create an Express handler for the WordPress MCP endpoint.
 * Reads X-Agent-Id and X-Board-Id headers for per-agent/board credential resolution.
 */
export function createWordPressMcpHandler() {
  return createMcpHttpHandler('WordPress', ({ agentId, boardId }) =>
    createWordPressMcpServer(agentId, boardId));
}
