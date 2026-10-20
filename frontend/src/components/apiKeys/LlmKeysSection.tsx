import { useMemo, useState } from 'react';
import { BookOpen, Bot, Key, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import type { ScopedApiKey, ScopedApiKeyCreated, ShowToastFn } from '../../types';
import CopyableCode from './CopyableCode';

interface LlmKeysSectionProps {
  /** The caller's llm keys (already filtered by the parent). */
  keys: ScopedApiKey[];
  /** Reload the parent's key list after a mint or a revoke. */
  onChanged: () => Promise<void>;
  /** Jump to the LLM section of the documentation tab. */
  onOpenDocs: () => void;
  onCreated?: (key: ScopedApiKeyCreated) => void;
  showToast?: ShowToastFn;
}

/**
 * LLM keys: an OpenAI-compatible chat-completions endpoint answered by one of
 * the caller's agents (`model` = agent name), for another service to call.
 *
 * Like browser keys a user holds as many as they like — one per consuming
 * service — and minting never rotates another one.
 */
export default function LlmKeysSection({
  keys,
  onChanged,
  onOpenDocs,
  onCreated,
  showToast,
}: LlmKeysSectionProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  /** Clear text of the key just minted. Shown once, until the next mint or close. */
  const [fresh, setFresh] = useState<ScopedApiKeyCreated | null>(null);

  const origin = window.location.origin;

  const freshSnippet = useMemo(() => {
    if (!fresh) return '';
    const body = JSON.stringify({
      model: '<agent name>',
      messages: [{ role: 'user', content: 'Hello!' }],
    });
    return [
      `curl -X POST '${origin}/api/llm/v1/chat/completions'`,
      `  -H 'Authorization: Bearer ${fresh.key}'`,
      `  -H 'Content-Type: application/json'`,
      `  -d '${body}'`,
    ].join(' \\\n');
  }, [fresh, origin]);

  const handleCreate = async () => {
    try {
      setCreating(true);
      const created = await api.createLlmApiKey(name.trim() || undefined);
      setFresh(created);
      onCreated?.(created);
      setName('');
      await onChanged();
      showToast?.('LLM key created', 'success');
    } catch {
      showToast?.('Failed to create LLM key', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ScopedApiKey) => {
    try {
      await api.revokeMyApiKey(key.id);
      if (fresh?.id === key.id) setFresh(null);
      await onChanged();
      showToast?.('LLM key revoked', 'success');
    } catch {
      showToast?.('Failed to revoke LLM key', 'error');
    }
  };

  return (
    <div className="bg-dark-800/60 border border-dark-700 rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Bot className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-medium text-dark-200">LLM keys</span>
            <code className="text-xs text-indigo-300 font-mono">/api/llm/v1</code>
          </div>
          <p className="text-xs text-dark-400 mt-1">
            An OpenAI-compatible chat-completions endpoint: set <code>model</code> to the name of
            one of your agents. The agent works on the request with its own tools, writes its answer
            to a file, and that file is returned as the completion. Opens nothing else. Create one
            key per service so each can be revoked on its own.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenDocs}
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-dark-300 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
        >
          <BookOpen className="w-3.5 h-3.5" />
          Docs
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={200}
          placeholder="Service name, e.g. Support chatbot"
          className="flex-1 min-w-0 bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-dark-200 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Create
        </button>
      </div>

      <p className="text-[11px] text-dark-500">
        Base URL for OpenAI SDKs: <code className="font-mono">{origin}/api/llm/v1</code> — one
        request at a time per agent; a busy agent answers 409.
      </p>

      {fresh && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
          <p className="text-xs text-emerald-400 font-medium">
            “{fresh.name}” — copy this key now, it won't be shown again.
          </p>
          <CopyableCode code={fresh.key} />
          <CopyableCode
            label="OpenAI SDK (Python)"
            code={`from openai import OpenAI\nclient = OpenAI(base_url='${origin}/api/llm/v1', api_key='${fresh.key}')\nprint(client.chat.completions.create(model='<agent name>', messages=[{'role': 'user', 'content': 'Hello!'}]).choices[0].message.content)`}
          />
          <CopyableCode label="Try it" code={freshSnippet} />
        </div>
      )}

      {keys.length > 0 ? (
        <ul className="space-y-1.5">
          {keys.map(k => (
            <li
              key={k.id}
              className="flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-xs"
            >
              <Key className="w-3.5 h-3.5 text-dark-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="text-dark-200 font-medium truncate">{k.name || 'llm key'}</span>
                <div className="flex items-center gap-3 text-dark-500 mt-0.5">
                  <code className="font-mono">{k.prefix}</code>
                  <span>
                    {k.last_used_at
                      ? `last used ${new Date(k.last_used_at).toLocaleDateString()}`
                      : 'never used'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRevoke(k)}
                className="p-1.5 text-dark-400 hover:text-red-400 rounded transition-colors"
                title="Revoke this key"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-dark-500">No LLM key yet.</p>
      )}
    </div>
  );
}
