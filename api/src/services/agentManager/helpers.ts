// ─── Standalone helper functions ─────────────────────────────────────────────
import fs from 'fs/promises';

// ─── File System Handoff ────────────────────────────────────────────────────────
export async function transferUserFiles(fromId: string, toId: string): Promise<{ success: boolean; message: string }> {
  const fromHomeDir = `/home/${fromId}`;
  const toHomeDir = `/home/${toId}`;

  try {
    await fs.access(fromHomeDir);
  } catch {
    // Agent home directories live in the runner-service container on most
    // deployments, not on this host — report that explicitly instead of
    // failing later with a misleading filesystem error.
    return { success: false, message: `Source home directory ${fromHomeDir} does not exist on this host — no files were transferred` };
  }

  try {
    // Copy into place: rename() fails with ENOTEMPTY when the target home
    // already has files and with EXDEV across filesystems (tmpfs /tmp).
    await fs.cp(fromHomeDir, toHomeDir, { recursive: true, force: true });
    return { success: true, message: 'File system handoff completed successfully' };
  } catch (error: any) {
    console.error('File system handoff failed:', error);
    return { success: false, message: error.message };
  }
}

// ─── MCP Schema Simplification ──────────────────────────────────────────────
export function simplifyMcpSchema(inputSchema: any): string {
  if (!inputSchema?.properties) return '{}';
  const props = inputSchema.properties;
  const required = new Set(inputSchema.required || []);
  const simplified: Record<string, string> = {};

  for (const [key, def] of Object.entries(props) as [string, any][]) {
    let typeStr = '';
    if (def.anyOf) {
      const types = def.anyOf.map((t: any) => t.type).filter(Boolean);
      typeStr = types.join('|');
    } else {
      typeStr = def.type || 'string';
    }
    if (def.default !== undefined && def.default !== null) {
      typeStr += `, default: ${def.default}`;
    } else if (def.default === null) {
      typeStr += ', optional';
    }
    if (required.has(key)) {
      typeStr += ', required';
    }
    simplified[key] = `<${typeStr}>`;
  }
  return JSON.stringify(simplified);
}
