// ── Balanced parsing helpers (mirrors server-side logic) ─────────────────────

function _findBalancedCloseUI(text, start) {
  let depth = 1, inTQ = false, inDQ = false, inSQ = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"' && text[i+1] === '"' && text[i+2] === '"') {
      if (inTQ) { inTQ = false; i += 2; continue; }
      if (!inDQ && !inSQ) { inTQ = true; i += 2; continue; }
    }
    if (inTQ) continue;
    if (text[i] === '\\' && (inDQ || inSQ)) { i++; continue; }
    if (text[i] === '"' && !inSQ) { inDQ = !inDQ; continue; }
    if (text[i] === "'" && !inDQ) { inSQ = !inSQ; continue; }
    if (!inDQ && !inSQ) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') { depth--; if (depth === 0) return i; }
    }
  }
  return -1;
}

function _findTopLevelCommaUI(text) {
  let inTQ = false, inDQ = false, inSQ = false, depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' && text[i+1] === '"' && text[i+2] === '"') {
      if (inTQ) { inTQ = false; i += 2; continue; }
      if (!inDQ && !inSQ) { inTQ = true; i += 2; continue; }
    }
    if (inTQ) continue;
    if (text[i] === '\\' && (inDQ || inSQ)) { i++; continue; }
    if (text[i] === '"' && !inSQ) { inDQ = !inDQ; continue; }
    if (text[i] === "'" && !inDQ) { inSQ = !inSQ; continue; }
    if (!inDQ && !inSQ) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (text[i] === ',' && depth === 0) return i;
    }
  }
  return -1;
}

function _stripWrapperQuotes(s) {
  s = s.trim();
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return s.slice(1, -1);
  }
  return s;
}

// Clean raw @tool() syntax and [Executing:...] markers from assistant text.
// Replaces them with clean markdown code blocks showing the command and hides
// the internal @tool_name wrapper.
export function cleanToolSyntax(text) {
  if (!text) return text;
  let cleaned = text;

  // Remove <think>...</think> reasoning blocks (from reasoning models like Qwen3)
  // Also handles unclosed <think> blocks (model ran out of tokens mid-reasoning)
  cleaned = cleaned.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');

  // Remove wrapper tags
  cleaned = cleaned.replace(/<\|?\/?tool_call\|?>/gi, '');
  cleaned = cleaned.replace(/<\|?\/?tool_use\|?>/gi, '');
  cleaned = cleaned.replace(/\[TOOL_CALLS?\]/gi, '');
  cleaned = cleaned.replace(/\n?\[Executing: @(?:read_file|write_file|list_dir|search_files|run_command|append_file)\([^)]*\)\.{3}\]\n?/gi, '');

  // Use balanced parser to find and replace @tool(...) calls
  const ALL_TOOLS = 'read_file|write_file|append_file|list_dir|search_files|run_command|report_error|list_my_tasks|check_status|list_projects|mcp_call|update_task';
  const toolPattern = new RegExp(`@(${ALL_TOOLS})\\s*\\(`, 'gi');
  let m;
  // Process from end to start so replacements don't shift indices
  const replacements = [];

  while ((m = toolPattern.exec(cleaned)) !== null) {
    const toolName = m[1].toLowerCase();
    const argsStart = m.index + m[0].length;
    const closeIdx = _findBalancedCloseUI(cleaned, argsStart);
    if (closeIdx === -1) continue;

    const argsString = cleaned.slice(argsStart, closeIdx);
    let replacement;

    if (toolName === 'run_command') {
      const cmd = _stripWrapperQuotes(argsString);
      replacement = `\n\`\`\`bash\n$ ${cmd}\n\`\`\`\n`;
    } else if (toolName === 'read_file') {
      const p = _stripWrapperQuotes(argsString);
      replacement = `\n> **Reading** \`${p}\`\n`;
    } else if (toolName === 'list_dir') {
      const p = _stripWrapperQuotes(argsString) || '.';
      replacement = `\n> **Listing** \`${p}\`\n`;
    } else if (toolName === 'write_file' || toolName === 'append_file') {
      const commaIdx = _findTopLevelCommaUI(argsString);
      if (commaIdx !== -1) {
        const p = _stripWrapperQuotes(argsString.slice(0, commaIdx));
        let content = argsString.slice(commaIdx + 1).trim();
        if (content.startsWith('"""') && content.endsWith('"""')) content = content.slice(3, -3);
        replacement = `\n> **Writing** \`${p}\`\n\`\`\`\n${content}\n\`\`\`\n`;
      } else {
        replacement = `\n> **Writing** \`${argsString.trim()}\`\n`;
      }
    } else if (toolName === 'search_files') {
      const commaIdx = _findTopLevelCommaUI(argsString);
      if (commaIdx !== -1) {
        const pat = argsString.slice(0, commaIdx).trim();
        const q = argsString.slice(commaIdx + 1).trim();
        replacement = `\n> **Searching** \`${pat}\` for *${q}*\n`;
      } else {
        replacement = `\n> **Searching** \`${argsString.trim()}\`\n`;
      }
    } else if (toolName === 'report_error') {
      const desc = _stripWrapperQuotes(argsString);
      replacement = `\n> 🚨 **Error reported:** ${desc}\n`;
    } else if (toolName === 'list_my_tasks' || toolName === 'check_status' || toolName === 'list_projects') {
      // Internal status checks — remove from display entirely
      replacement = '';
    } else if (toolName === 'mcp_call') {
      const commaIdx = _findTopLevelCommaUI(argsString);
      if (commaIdx !== -1) {
        const server = _stripWrapperQuotes(argsString.slice(0, commaIdx));
        const rest = argsString.slice(commaIdx + 1).trim();
        const commaIdx2 = _findTopLevelCommaUI(rest);
        const tool = commaIdx2 !== -1 ? _stripWrapperQuotes(rest.slice(0, commaIdx2)) : _stripWrapperQuotes(rest);
        replacement = `\n> 🔌 **MCP:** ${tool} on \`${server}\`\n`;
      } else {
        replacement = `\n> 🔌 **MCP call:** ${_stripWrapperQuotes(argsString)}\n`;
      }
    } else if (toolName === 'update_task') {
      const commaIdx = _findTopLevelCommaUI(argsString);
      if (commaIdx !== -1) {
        const rest = argsString.slice(commaIdx + 1).trim();
        const commaIdx2 = _findTopLevelCommaUI(rest);
        const status = commaIdx2 !== -1 ? _stripWrapperQuotes(rest.slice(0, commaIdx2)) : _stripWrapperQuotes(rest);
        replacement = `\n> 📋 **Task updated** → ${status}\n`;
      } else {
        replacement = `\n> 📋 **Task updated**\n`;
      }
    }

    if (replacement) {
      replacements.push({ start: m.index, end: closeIdx + 1, replacement });
    }
    toolPattern.lastIndex = closeIdx + 1;
  }

  // Apply replacements from end to start
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    cleaned = cleaned.slice(0, r.start) + r.replacement + cleaned.slice(r.end);
  }

  return cleaned;
}
