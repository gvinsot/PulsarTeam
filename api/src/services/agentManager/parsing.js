// ─── Parsing: _parseAskCommands, _listAvailableProjects ──
import { listStarredRepos } from '../githubProjects.js';

/** @this {import('./index.js').AgentManager} */
export const parsingMethods = {

  _parseAskCommands(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const asks = [];
    const askRe = /@ask\s*\(/gi;
    let reMatch;
    while ((reMatch = askRe.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;

      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const agentName = text.slice(startAfterParen, commaIdx).trim();

      let i = commaIdx + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quoteChar = text[i];
      if (quoteChar !== '"' && quoteChar !== "'") continue;
      i++;

      let questionContent = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          questionContent += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quoteChar) {
          let j = i + 1;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (j < text.length && text[j] === ')') {
            found = true;
            break;
          }
          questionContent += text[i];
          i++;
          continue;
        }
        questionContent += text[i];
        i++;
      }

      if (found && agentName && questionContent.trim()) {
        asks.push({ agentName, question: questionContent.trim() });
      }
    }
    return asks;
  },

  async _listAvailableProjects() {
    try {
      const repos = await listStarredRepos();
      return repos.map(r => r.name).sort();
    } catch {
      return [];
    }
  },
};
