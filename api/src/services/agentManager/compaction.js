// ─── Compaction: thresholds, token helpers, history compaction, context switch ─
import { createProvider } from '../llmProviders.js';
import { saveAgent } from '../database.js';

/** @this {import('./index.js').AgentManager} */
export const compactionMethods = {

  /**
   * Compute dynamic compaction thresholds based on context window size.
   */
  _compactionThresholds(contextLimit) {
    if (contextLimit >= 200000) {
      return { maxRecent: 80, compactTrigger: 110, compactReset: 90, safetyRatio: 0.80 };
    } else if (contextLimit >= 128000) {
      return { maxRecent: 40, compactTrigger: 55, compactReset: 45, safetyRatio: 0.80 };
    } else if (contextLimit >= 32000) {
      return { maxRecent: 16, compactTrigger: 24, compactReset: 20, safetyRatio: 0.75 };
    } else {
      return { maxRecent: 10, compactTrigger: 15, compactReset: 12, safetyRatio: 0.75 };
    }
  },

  /**
   * Rough token estimation (~3 chars per token).
   */
  _estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) {
      chars += (m.content || '').length;
    }
    return Math.ceil(chars / 3.0);
  },

  /**
   * Compute a safe maxTokens value that won't exceed the model's context window.
   */
  _safeMaxTokens(messages, agent, llmConfig = null) {
    const contextLength = (llmConfig?.contextLength) || agent.contextLength || 131072;
    const desiredMaxTokens = (llmConfig?.maxTokens) || agent.maxTokens || 4096;
    const estimatedInput = this._estimateTokens(messages);
    const safetyMargin = Math.ceil(contextLength * 0.15);
    const available = contextLength - estimatedInput - safetyMargin;
    if (available < desiredMaxTokens) {
      const capped = Math.max(1024, available);
      if (capped !== desiredMaxTokens) {
        console.log(`⚠️  [TokenCap] "${agent.name}": capping maxTokens from ${desiredMaxTokens} to ${capped} (input ~${estimatedInput}, context ${contextLength})`);
      }
      return capped;
    }
    return desiredMaxTokens;
  },

  _isContextExceededError(errMsg) {
    const lower = (errMsg || '').toLowerCase();
    return [
      'context length', 'context_length', 'num_ctx', 'context window',
      'too long', 'maximum context', 'exceeds', 'token limit',
      'kv cache full', 'prompt is too long', 'input too long',
      'context_length_exceeded'
    ].some(kw => lower.includes(kw));
  },

  _parseRateLimitReset(text) {
    if (!text) return null;
    const match = text.match(/(?:hit your limit|rate.limit|limit.reached)[\s\S]*?resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const ampm = match[3].toLowerCase();
    const tz = match[4] || 'Europe/Paris';

    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayStr = formatter.format(now);
    const resetStr = `${todayStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;

    const resetInTz = new Date(resetStr);
    const utcDate = new Date(resetInTz.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(resetInTz.toLocaleString('en-US', { timeZone: tz }));
    const offsetMs = utcDate - tzDate;
    let resetUtc = new Date(resetInTz.getTime() + offsetMs);

    if (resetUtc.getTime() <= now.getTime()) {
      resetUtc = new Date(resetUtc.getTime() + 24 * 60 * 60 * 1000);
    }

    const retryAt = resetUtc.getTime() + 5 * 60 * 1000;
    const resetLabel = `${match[1]}${match[2] ? ':' + match[2] : ''}${ampm} (${tz})`;

    console.log(`🕐 [Rate Limit] Parsed reset: ${resetLabel} → retry at ${new Date(retryAt).toISOString()}`);
    return { retryAt, resetLabel };
  },

  /**
   * Truncate individual messages so total estimated tokens fits within context limit.
   */
  _truncateMessagesToFit(messages, contextLimit, reserveOutputTokens = 1024) {
    const target = contextLimit - reserveOutputTokens - Math.ceil(contextLimit * 0.10);
    let estimated = this._estimateTokens(messages);
    if (estimated <= target) return false;

    const MIN_CONTENT = 500;

    const candidates = messages
      .map((m, i) => ({ index: i, len: (m.content || '').length }))
      .filter(c => c.index > 0 && c.len > MIN_CONTENT)
      .sort((a, b) => b.len - a.len);

    let truncated = false;
    for (const c of candidates) {
      if (estimated <= target) break;
      const msg = messages[c.index];
      const content = msg.content || '';
      const excessTokens = estimated - target;
      const excessChars = excessTokens * 3;
      const newLen = Math.max(MIN_CONTENT, content.length - excessChars);
      if (newLen < content.length) {
        msg.content = content.slice(0, newLen) + `\n\n... [truncated from ${content.length} to ${newLen} chars to fit context window]`;
        estimated = this._estimateTokens(messages);
        truncated = true;
      }
    }

    if (truncated) {
      console.log(`✂️  [Truncate] Messages truncated to fit context: ~${estimated} tokens (target: ${target}, limit: ${contextLimit})`);
    }
    return truncated;
  },

  /**
   * Compact (summarize) the conversation history to free up context space.
   */
  async _compactHistory(agent, keepRecent = 10) {
    const history = agent.conversationHistory;
    if (history.length <= keepRecent + 2) {
      agent.conversationHistory = history.slice(-keepRecent);
      saveAgent(agent);
      console.log(`🗜️  [Compact] "${agent.name}": hard truncation to ${agent.conversationHistory.length} msgs (history too short for summary)`);
      return;
    }

    const contextLimit = this.resolveLlmConfig(agent).contextLength || agent.contextLength || 8192;

    const perMsgTruncate = contextLimit >= 200000 ? 8000
                         : contextLimit >= 128000 ? 6000
                         : contextLimit >= 32000  ? 4000
                         : 2000;
    const summaryInputCap = contextLimit >= 200000 ? 100000
                          : contextLimit >= 128000 ? 60000
                          : contextLimit >= 32000  ? 30000
                          : 12000;
    const summaryMaxTokens = contextLimit >= 200000 ? 4096
                           : contextLimit >= 128000 ? 3072
                           : contextLimit >= 32000  ? 2048
                           : 1024;
    const summaryMaxWords = contextLimit >= 128000 ? 2000 : 500;

    const existingSummary = history.find(m => m.type === 'compaction-summary');
    const realHistory = history.filter(m => m.type !== 'compaction-summary');

    const toSummarize = realHistory.slice(0, realHistory.length - keepRecent);
    const toKeep = realHistory.slice(-keepRecent);

    const summaryParts = [];

    if (existingSummary) {
      summaryParts.push(`[PREVIOUS SUMMARY]:\n${existingSummary.content}`);
    }

    for (const m of toSummarize) {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const rawContent = m.content || '';
      const content = rawContent.length > perMsgTruncate
        ? rawContent.slice(0, perMsgTruncate) + `... [truncated, ${rawContent.length} chars total]`
        : rawContent;
      summaryParts.push(`[${role}]: ${content}`);
    }

    const summaryInput = summaryParts.join('\n\n');

    try {
      const llmConfig = this.resolveLlmConfig(agent);
      const provider = createProvider({
        provider: llmConfig.provider,
        model: llmConfig.model,
        endpoint: llmConfig.endpoint,
        apiKey: llmConfig.apiKey,
        agentId: agent.id,
        ownerId: agent.ownerId || null
      });

      const msgCount = toSummarize.length + (existingSummary ? 1 : 0);
      console.log(`🗜️  [Compact] "${agent.name}": summarizing ${msgCount} messages (${summaryInput.length} chars input, cap ${summaryInputCap}), keeping ${toKeep.length} recent, context ${contextLimit}, model=${llmConfig.model}`);

      const maxSummaryInputChars = Math.min(summaryInputCap, (contextLimit - summaryMaxTokens - 1000) * 3);
      const summaryMessages = [
        {
          role: 'system',
          content: `You are a conversation summarizer. Produce a concise but thorough summary of the conversation below.${existingSummary ? ' A previous summary is included — integrate it with the new messages into one unified summary.' : ''} Preserve: key decisions made, files modified and their changes, errors encountered and how they were resolved, current task status, tools/commands used, and any important context the assistant needs to continue working effectively. Be factual and structured. Use bullet points grouped by topic. Maximum ${summaryMaxWords} words.`
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${summaryInput.slice(0, maxSummaryInputChars)}`
        }
      ];
      this._truncateMessagesToFit(summaryMessages, contextLimit, summaryMaxTokens);

      let summaryResponse = await provider.chat(summaryMessages, {
        temperature: 0.2,
        maxTokens: summaryMaxTokens,
        contextLength: contextLimit
      });

      let summaryText = summaryResponse.content || '';

      if (!summaryText.trim()) {
        console.warn(`🗜️  [Compact] "${agent.name}": first summary attempt returned empty (model=${llmConfig.model}) — retrying with simpler prompt`);
        const retryMessages = [
          { role: 'user', content: `Summarize the following conversation in bullet points. Keep it concise.\n\n${summaryInput.slice(0, Math.floor(maxSummaryInputChars / 2))}` }
        ];
        this._truncateMessagesToFit(retryMessages, contextLimit, summaryMaxTokens);
        summaryResponse = await provider.chat(retryMessages, {
          temperature: 0.3,
          maxTokens: summaryMaxTokens,
          contextLength: contextLimit
        });
        summaryText = summaryResponse.content || '';
      }

      if (!summaryText.trim()) throw new Error(`Empty summary after retry (model=${llmConfig.model}, provider=${llmConfig.provider})`);

      agent.conversationHistory = [
        {
          role: 'assistant',
          content: `[CONVERSATION SUMMARY — earlier messages were compacted to save context]\n\n${summaryText}`,
          timestamp: new Date().toISOString(),
          type: 'compaction-summary'
        },
        ...toKeep
      ];

      saveAgent(agent);
      console.log(`🗜️  [Compact] "${agent.name}": compacted ${history.length} → ${agent.conversationHistory.length} messages (summary: ${summaryText.length} chars)`);

    } catch (summaryErr) {
      console.warn(`🗜️  [Compact] "${agent.name}": summarization failed (${summaryErr.message}), building mechanical summary`);

      const filesRead = new Set();
      const filesWritten = new Set();
      const commandsRun = [];
      const toolCalls = [];
      const errors = [];
      const userRequests = [];

      for (const m of toSummarize) {
        const content = m.content || '';
        if (m.role === 'assistant') {
          const reads = content.match(/@read_file\(([^)]{1,120})\)/g);
          if (reads) reads.forEach(r => {
            const match = r.match(/@read_file\(([^,)]+)/);
            if (match) filesRead.add(match[1].trim().replace(/^["']|["']$/g, ''));
          });
          const writes = content.match(/@write_file\(([^,]{1,120})/g);
          if (writes) writes.forEach(w => {
            const match = w.match(/@write_file\(([^,]+)/);
            if (match) filesWritten.add(match[1].trim().replace(/^["']|["']$/g, ''));
          });
          const cmds = content.match(/@run_command\(([^)]{1,200})\)/g);
          if (cmds) commandsRun.push(...cmds.slice(0, 3).map(c => c.slice(13, -1).slice(0, 80)));
          const otherTools = content.match(/@(?:search_files|list_dir|append_file|mcp_call)\([^)]{0,80}\)/g);
          if (otherTools) toolCalls.push(...otherTools.slice(0, 5));
        } else if (m.role === 'user') {
          if (content.includes('Error') || content.includes('error') || content.includes('failed')) {
            const errPreview = content.slice(0, 150).replace(/\n/g, ' ');
            errors.push(errPreview);
          }
          if (!m.type && content.length > 10 && content.length < 500) {
            userRequests.push(content.slice(0, 150));
          }
        }
      }

      const parts = [];
      parts.push(`[MECHANICAL SUMMARY — ${toSummarize.length} messages compacted]`);
      if (userRequests.length > 0) parts.push(`Tasks: ${userRequests.slice(0, 3).join(' | ')}`);
      if (filesRead.size > 0) parts.push(`Read ${filesRead.size} file(s): ${[...filesRead].slice(0, 5).join(', ')}${filesRead.size > 5 ? ` +${filesRead.size - 5} more` : ''}`);
      if (filesWritten.size > 0) parts.push(`Wrote ${filesWritten.size} file(s): ${[...filesWritten].slice(0, 5).join(', ')}${filesWritten.size > 5 ? ` +${filesWritten.size - 5} more` : ''}`);
      if (commandsRun.length > 0) parts.push(`Ran ${commandsRun.length} command(s)`);
      if (toolCalls.length > 0) parts.push(`${toolCalls.length} other tool call(s)`);
      if (errors.length > 0) parts.push(`${errors.length} error(s): ${errors[0].slice(0, 80)}`);
      const mechanicalSummary = parts.join('\n');

      if (existingSummary) {
        existingSummary.content += `\n\n${mechanicalSummary}`;
        agent.conversationHistory = [existingSummary, ...toKeep];
      } else {
        agent.conversationHistory = [
          {
            role: 'assistant',
            content: mechanicalSummary,
            timestamp: new Date().toISOString(),
            type: 'compaction-summary'
          },
          ...toKeep
        ];
      }
      const maxPerMsg = Math.floor((contextLimit * 3) / Math.max(agent.conversationHistory.length, 1) * 0.6);
      for (const m of agent.conversationHistory) {
        if (m.type === 'compaction-summary') continue;
        if ((m.content || '').length > maxPerMsg) {
          m.content = m.content.slice(0, maxPerMsg) + `\n\n... [hard-truncated from ${m.content.length} to ${maxPerMsg} chars]`;
        }
      }
      saveAgent(agent);
    }

    this._emit('agent:updated', this._sanitize(agent));
  },
};
