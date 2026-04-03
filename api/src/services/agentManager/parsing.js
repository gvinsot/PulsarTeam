// ─── Parsing: all _parse* methods, _listAvailableProjects, _executeSingleDelegation ──
import { listStarredRepos } from '../githubProjects.js';
import { saveTaskToDb } from '../database.js';

/** @this {import('./index.js').AgentManager} */
export const parsingMethods = {

  _parseDelegations(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const delegations = [];
    const delegateRe = /@delegate\s*\(/gi;
    let reMatch;
    while ((reMatch = delegateRe.exec(text)) !== null) {
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

      let taskContent = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          taskContent += text[i] + text[i + 1];
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
          taskContent += text[i];
          i++;
          continue;
        }
        taskContent += text[i];
        i++;
      }

      if (found && agentName && taskContent.trim()) {
        delegations.push({ agentName, task: taskContent.trim() });
      }
    }
    return delegations;
  },

  _parseProjectAssignments(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const assignments = [];
    const re = /@assign_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;

      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, commaIdx).trim();

      let i = commaIdx + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quoteChar = text[i];
      if (quoteChar !== '"' && quoteChar !== "'") continue;
      i++;

      let projectName = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          projectName += text[i + 1];
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
          projectName += text[i];
          i++;
          continue;
        }
        projectName += text[i];
        i++;
      }

      if (found && targetAgentName && projectName.trim()) {
        assignments.push({ targetAgentName, projectName: projectName.trim() });
      }
    }
    return assignments;
  },

  _parseGetProject(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@get_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  },

  _parseClearContext(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@clear_context\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  },

  _parseAgentStatus(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@agent_status\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  },

  _parseGetAvailableAgent(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@get_available_agent\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const role = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (role) {
        results.push({ role });
      }
    }
    return results;
  },

  _parseAgentsOnProject(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@agents_on_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const projectName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (projectName) {
        results.push({ projectName });
      }
    }
    return results;
  },

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

  _parseStopAgent(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@stop_agent\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  },

  _parseRollback(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@rollback\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, commaIdx).trim().replace(/^["']|["']$/g, '');
      const closeIdx = text.indexOf(')', commaIdx + 1);
      if (closeIdx === -1) continue;
      const countStr = text.slice(commaIdx + 1, closeIdx).trim();
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count <= 0) continue;
      if (targetAgentName) {
        results.push({ targetAgentName, count });
      }
    }
    return results;
  },

  async _listAvailableProjects() {
    try {
      const repos = await listStarredRepos();
      return repos.map(r => r.name).sort();
    } catch {
      return [];
    }
  },

  async _executeSingleDelegation(leaderId, delegation, streamCallback, delegationDepth) {
    const leader = this.agents.get(leaderId);
    const targetAgent = Array.from(this.agents.values()).find(
      a => a.name.toLowerCase() === delegation.agentName.toLowerCase() && a.id !== leaderId
    );

    if (!targetAgent) {
      console.log(`⚠️  Agent "${delegation.agentName}" not found in swarm`);
      if (streamCallback) streamCallback(`\n⚠️ Agent "${delegation.agentName}" not found in swarm\n`);
      return { agentName: delegation.agentName, response: null, error: `Agent "${delegation.agentName}" not found in swarm` };
    }

    try {
      console.log(`📨 Delegating to ${targetAgent.name}: ${delegation.task.slice(0, 80)}...`);
      if (streamCallback) streamCallback(`\n\n--- 📨 Delegating to ${targetAgent.name} ---\n`);

      this._emit('agent:delegation', {
        from: { id: leaderId, name: leader.name, project: leader.project || null },
        to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
        task: delegation.task
      });

      const createdTask = this.addTask(targetAgent.id, `[From ${leader.name}] ${delegation.task}`, leader.project || null, { type: 'agent', name: leader.name, id: leaderId });

      let delegateStreamStarted = false;
      const agentResponse = await this.sendMessage(
        targetAgent.id,
        `[TASK from ${leader.name}]: ${delegation.task}`,
        (chunk) => {
          if (streamCallback) {
            if (!delegateStreamStarted) {
              delegateStreamStarted = true;
              streamCallback(`\n**[${targetAgent.name}]:**\n`);
            }
            streamCallback(chunk);
          }
        },
        delegationDepth + 1,
        { type: 'delegation-task', fromAgent: leader.name }
      );

      if (createdTask) {
        const t = this._getAgentTasks(targetAgent.id).find(t => t.id === createdTask.id);
        if (t) {
          t.status = 'done';
          t.completedAt = new Date().toISOString();
          saveTaskToDb({ ...t, agentId: targetAgent.id });
          this._emit('agent:updated', this._sanitize(targetAgent));
        }
      }

      return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
    } catch (err) {
      return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: null, error: err.message };
    }
  },
};
