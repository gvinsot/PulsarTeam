// ─── Standalone helper functions ─────────────────────────────────────────────
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

// ─── File System Handoff ────────────────────────────────────────────────────────
export async function transferUserFiles(fromId, toId) {
  const tempDir = path.join('/tmp', `handoff-${uuidv4()}`);
  const fromHomeDir = `/home/${fromId}`;
  const toHomeDir = `/home/${toId}`;

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.cp(fromHomeDir, tempDir, { recursive: true });
    await fs.chmod(tempDir, 0o755);
    await fs.rename(tempDir, toHomeDir);
    return { success: true, message: 'File system handoff completed successfully' };
  } catch (error) {
    console.error('File system handoff failed:', error);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    return { success: false, message: error.message };
  }
}

// ─── MCP Schema Simplification ──────────────────────────────────────────────
export function simplifyMcpSchema(inputSchema) {
  if (!inputSchema?.properties) return '{}';
  const props = inputSchema.properties;
  const required = new Set(inputSchema.required || []);
  const simplified = {};

  for (const [key, def] of Object.entries(props)) {
    let typeStr = '';
    if (def.anyOf) {
      const types = def.anyOf.map(t => t.type).filter(Boolean);
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
