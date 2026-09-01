import { useState, useEffect } from 'react';
import { Save, Trash2, RotateCw, Power, Users } from 'lucide-react';
import { api } from '../../api';
import type { AgentWriteInput } from '../../api';
import CodexAuthSection from './CodexAuthSection';
import { useEnabledAgentTypes } from '../../hooks/useEnabledAgentTypes';
import {
  AGENT_TYPE_OPTION_LABELS,
  AGENT_TYPE_SELECT_ORDER,
  normalizeAgentType,
} from '../../utils/agentTypes';
import type {
  Agent,
  AgentRunner,
  AppUser,
  BoardListItem,
  LlmConfig,
  RepoPickerOption,
  UserRole,
} from '../../types';

// Runners that pick their model inside the terminal (Claude Code plan / Codex
// plan), not from Settings. The LLM selector is hidden for them and any
// per-agent llmConfigId is cleared.
const MODEL_IN_TERMINAL_RUNNERS = new Set(['claudecode', 'codex']);

// The exact option set the runner <select> below renders; '' is the "Auto"
// entry. 'coder' is part of AgentRunner but is deliberately not offered here.
// A <select>'s value is typed `string` by React, so this list is what turns it
// back into SettingsForm['runner'] without an assertion.
const RUNNER_SELECT_VALUES = [
  '',
  'sandbox',
  'claudecode',
  'openclaw',
  'hermes',
  'opencode',
  'aider',
  'codex',
] as const;

function isRunnerSelectValue(value: string): value is (typeof RUNNER_SELECT_VALUES)[number] {
  return RUNNER_SELECT_VALUES.some(option => option === value);
}

/**
 * The editable copy of the agent held while the tab is open. It mirrors Agent's
 * own optionality (name/role/description/icon/color are optional there because
 * loadFromDatabase never re-defaults them) and keeps the two cost fields in the
 * '' = "unset" form the save path converts back to null.
 */
interface SettingsForm {
  name?: string;
  role?: string;
  description?: string;
  llmConfigId: string;
  icon?: string;
  color?: string;
  project: string;
  enabled: boolean;
  costPerInputToken: number | '';
  costPerOutputToken: number | '';
  boardId: string;
  /** '' is the "Auto" option, resolved to a concrete runner on save. */
  runner: AgentRunner | '';
  ttsEnabled: boolean;
}

export default function SettingsTab({
  agent,
  projects: _projects,
  currentProject,
  onRefresh,
  userRole: _userRole,
  currentUser,
}: {
  agent: Agent;
  /** App normalises the repo list client-side before it gets here. */
  projects?: RepoPickerOption[];
  currentProject?: string;
  onRefresh: () => void;
  userRole?: UserRole;
  currentUser?: AppUser | null;
}) {
  const [form, setForm] = useState<SettingsForm>({
    name: agent.name,
    role: agent.role,
    description: agent.description,
    llmConfigId: agent.llmConfigId || '',
    icon: agent.icon,
    color: agent.color,
    project: agent.project || '',
    enabled: agent.enabled !== false,
    costPerInputToken: agent.costPerInputToken ?? '',
    costPerOutputToken: agent.costPerOutputToken ?? '',
    boardId: agent.boardId || '',
    runner: agent.runner || '',
    ttsEnabled: agent.ttsEnabled || false,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [batching, setBatching] = useState(false);
  const [batchSize, setBatchSize] = useState(2);
  const [llmConfigs, setLlmConfigs] = useState<LlmConfig[]>([]);
  const [boards, setBoards] = useState<BoardListItem[]>([]);
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const { isAgentTypeEnabled } = useEnabledAgentTypes();

  // The runner <select> lists the agent types an admin has left enabled, plus
  // the one this agent already runs on when that has since been switched off —
  // otherwise the select would render blank and silently re-point the agent on
  // the next save. The API accepts an unchanged runner for the same reason.
  const runnerOptions = AGENT_TYPE_SELECT_ORDER.filter(
    id => isAgentTypeEnabled(id) || normalizeAgentType(agent.runner) === id
  );

  useEffect(() => {
    api
      .getLlmConfigs()
      .then(setLlmConfigs)
      .catch(() => {});
    api
      .getBoards()
      .then(setBoards)
      .catch(() => {});
    api
      .getExternalVoiceServices(agent.id)
      .then(data => setTtsAvailable(!!data?.tts?.available))
      .catch(() => setTtsAvailable(false));
  }, [agent.id]);

  // Reset form when switching agents
  useEffect(() => {
    setForm({
      name: agent.name,
      role: agent.role,
      description: agent.description,
      llmConfigId: agent.llmConfigId || '',
      icon: agent.icon,
      color: agent.color,
      project: agent.project || '',
      enabled: agent.enabled !== false,
      costPerInputToken: agent.costPerInputToken ?? '',
      costPerOutputToken: agent.costPerOutputToken ?? '',
      boardId: agent.boardId || '',
      runner: agent.runner || '',
      ttsEnabled: agent.ttsEnabled || false,
    });
    setSaved(false);
    setBatchSize(2);
  }, [agent.id]);

  useEffect(() => {
    setForm(prev => {
      const nextProject = currentProject || '';
      return prev.project === nextProject ? prev : { ...prev, project: nextProject };
    });
  }, [currentProject]);

  // Auto-select a runner based on the LLM config provider.
  // Mirrors the "Auto" option in the runner dropdown.
  const resolveAutoRunner = (llmConfigId: string): AgentRunner => {
    const sel = llmConfigs.find(c => c.id === llmConfigId);
    const provider = (sel?.provider || '').toLowerCase();
    const byProvider: AgentRunner =
      provider === 'anthropic' || provider === 'claude' || provider === 'claude-paid'
        ? 'claudecode'
        : provider === 'openai'
          ? 'codex'
          : 'sandbox';
    // "Auto" is resolved client-side on save, so it must not land on a type an
    // admin switched off — the API would reject the save. Fall back to the
    // first runner still on offer (runnerOptions is never empty in practice:
    // it keeps the agent's current runner even when disabled).
    if (isAgentTypeEnabled(byProvider)) return byProvider;
    return runnerOptions[0] || byProvider;
  };

  // Whether a given LLM config may be paired with a given runner. Claude Code
  // only drives Anthropic models and Codex only OpenAI models; other runners
  // accept any provider. An empty llmConfigId ("Default LLM") is always allowed
  // because the runner falls back to its built-in credentials.
  const isLlmAllowedForRunner = (llmConfigId: string, runner: string) => {
    if (!llmConfigId) return true;
    const sel = llmConfigs.find(c => c.id === llmConfigId);
    const provider = (sel?.provider || '').toLowerCase();
    if (runner === 'claudecode') {
      return provider === 'anthropic' || provider === 'claude' || provider === 'claude-paid';
    }
    if (runner === 'codex') {
      return provider === 'openai';
    }
    return true;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Built in one literal rather than mutated in place: the wire shape
      // (AgentWriteInput) admits nulls where the form holds '' sentinels, so the
      // two cannot share a variable once they are typed. The values are the same
      // ones the previous mutations produced, in the same order — including
      // resolveAutoRunner seeing the empty/absent llmConfigId, which it looks up
      // and misses either way. `String()` is what parseFloat already did to a
      // numeric cost internally.
      const payload: AgentWriteInput = {
        ...form,
        costPerInputToken:
          form.costPerInputToken !== '' ? parseFloat(String(form.costPerInputToken)) || null : null,
        costPerOutputToken:
          form.costPerOutputToken !== ''
            ? parseFloat(String(form.costPerOutputToken)) || null
            : null,
        llmConfigId: form.llmConfigId || null,
        boardId: form.boardId || null,
        // "Auto" resolves to a concrete runner so the backend (which rejects null/empty) accepts it.
        runner: form.runner || resolveAutoRunner(form.llmConfigId),
      };
      // Claude Code / Codex choose their model in the terminal — never persist a
      // per-agent LLM config for them, even if one lingered from a prior runner.
      if (payload.runner && MODEL_IN_TERMINAL_RUNNERS.has(payload.runner)) {
        payload.llmConfigId = null;
      }
      await api.updateAgent(agent.id, payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteAgent(agent.id);
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setDeleting(false);
    }
  };

  const handleConvertToBatch = async () => {
    const total = Math.max(2, Math.min(50, Number(batchSize) || 2));
    if (
      !confirm(
        `Convert "${agent.name}" into a batch of ${total} agents? The current agent will become #1 and keep its history and tasks.`
      )
    )
      return;
    setBatching(true);
    try {
      await api.convertAgentToBatch(agent.id, total);
      onRefresh();
    } catch (err) {
      console.error(err);
      alert((err as any)?.message || 'Failed to convert agent to batch.');
    } finally {
      setBatching(false);
    }
  };

  const updateField = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm(prev => {
      const next: SettingsForm = { ...prev };
      next[key] = value;
      return next;
    });

  return (
    <div className="p-4 space-y-4">
      {/* Enabled toggle */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <div>
          <span className="text-sm text-dark-200">Agent enabled</span>
          <p className="text-[11px] text-dark-500 mt-0.5">
            Disabled agents are excluded from delegation, broadcast, and handoff
          </p>
        </div>
        <button
          onClick={async () => {
            const newEnabled = !form.enabled;
            updateField('enabled', newEnabled);
            try {
              await api.updateAgent(agent.id, { enabled: newEnabled });
              onRefresh();
            } catch (err) {
              console.error(err);
              updateField('enabled', !newEnabled);
            }
          }}
          className={`relative w-10 h-5 rounded-full transition-colors ${form.enabled ? 'bg-indigo-500' : 'bg-dark-600'}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${form.enabled ? 'translate-x-5' : ''}`}
          />
        </button>
      </div>

      {!agent.isVoice && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
          <div className="flex items-center gap-2 min-w-0">
            <Users className="w-4 h-4 text-indigo-400 flex-shrink-0" />
            <div className="min-w-0">
              <span className="text-sm text-dark-200">
                {agent.batchId ? 'Batch member' : 'Batch'}
              </span>
              {agent.batchId && (
                <p className="text-[11px] text-dark-500 mt-0.5">
                  Member #{agent.batchIndex ?? '?'}
                </p>
              )}
            </div>
          </div>
          {!agent.batchId && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <input
                type="number"
                min={2}
                max={50}
                value={batchSize}
                onChange={e =>
                  setBatchSize(Math.max(2, Math.min(50, parseInt(e.target.value) || 2)))
                }
                className="w-16 px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                title="Total agents"
              />
              <button
                onClick={handleConvertToBatch}
                disabled={batching}
                className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-colors flex items-center gap-1.5"
                title="Convert to batch"
              >
                {batching ? (
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Users className="w-3.5 h-3.5" />
                )}
                Convert
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={e => updateField('name', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Role</label>
          <input
            type="text"
            value={form.role}
            onChange={e => updateField('role', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Icon</label>
          <input
            type="text"
            value={form.icon}
            onChange={e => updateField('icon', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
            maxLength={4}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={e => updateField('description', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 resize-none"
            rows={2}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Runner (execution backend)</label>
          <select
            value={form.runner}
            onChange={e => {
              const nextRunner = e.target.value;
              if (isRunnerSelectValue(nextRunner)) updateField('runner', nextRunner);
              // Claude Code / Codex pick their model in the terminal, so clear
              // any per-agent LLM config when switching to them. Other runners
              // only clear on a provider mismatch (kept for safety).
              if (
                MODEL_IN_TERMINAL_RUNNERS.has(nextRunner) ||
                !isLlmAllowedForRunner(form.llmConfigId, nextRunner)
              ) {
                updateField('llmConfigId', '');
              }
            }}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="">Auto (based on LLM config)</option>
            {runnerOptions.map(id => (
              <option key={id} value={id}>
                {AGENT_TYPE_OPTION_LABELS[id]}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-dark-500 mt-1">
            Choose the container runtime for this agent first, then pick a compatible model below.
            "Auto" selects based on the LLM configuration.
          </p>
        </div>

        {MODEL_IN_TERMINAL_RUNNERS.has(form.runner) ? (
          <div className="col-span-2">
            <label className="block text-xs text-dark-400 mb-1.5">LLM Configuration (model)</label>
            <div className="px-3 py-2.5 bg-dark-700/40 rounded-lg border border-dark-600/50 text-xs text-dark-400">
              {form.runner === 'claudecode'
                ? 'Claude Code chooses its model directly in the terminal (via its plan / OAuth login). No model is selected here.'
                : 'Codex chooses its model directly in the terminal (via its ChatGPT plan login). No model is selected here.'}
            </div>
          </div>
        ) : (
          <div className="col-span-2">
            <label className="block text-xs text-dark-400 mb-1.5">LLM Configuration (model)</label>
            {(() => {
              // For the multi-provider CLI runners (opencode, openclaw, hermes,
              // aider) and sandbox/Auto, any configured LLM is selectable. The
              // chosen one is the default; for opencode the local vLLM/Ollama
              // models are also injected into the runner config so they can be
              // switched inside the terminal (see runner-service).
              const CLI_RUNNERS = new Set(['opencode', 'hermes', 'openclaw', 'aider']);
              const effectiveRunner = form.runner || resolveAutoRunner(form.llmConfigId);
              const isCliRunner = CLI_RUNNERS.has(effectiveRunner);
              const placeholderLabel = isCliRunner
                ? 'Default LLM (use runner’s built-in model)'
                : '-- Select an LLM config --';
              const modelOptions = (
                agent.isVoice
                  ? llmConfigs.filter(c => c.model && c.model.includes('gpt-realtime'))
                  : llmConfigs
              ).filter(c => isLlmAllowedForRunner(c.id, form.runner));
              return (
                <select
                  value={form.llmConfigId}
                  onChange={e => updateField('llmConfigId', e.target.value)}
                  className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">{placeholderLabel}</option>
                  {modelOptions.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.provider}/{c.model})
                    </option>
                  ))}
                </select>
              );
            })()}
            {['opencode', 'hermes', 'openclaw', 'aider'].includes(form.runner) && (
              <p className="text-[11px] text-dark-500 mt-1">
                Local vLLM/Ollama models are also injected into the runner; OpenCode lets you switch
                between them in the terminal. Your selection here is the default.
              </p>
            )}
            {agent.isVoice &&
              !llmConfigs.some(c => c.model && c.model.includes('gpt-realtime')) && (
                <p className="text-[11px] text-amber-400 mt-1">
                  No realtime LLM config found. Create one with model "gpt-realtime-1.5" in Admin
                  Settings.
                </p>
              )}
            {form.llmConfigId &&
              (() => {
                const sel = llmConfigs.find(c => c.id === form.llmConfigId);
                return sel ? (
                  <div className="mt-2 p-2.5 bg-dark-700/50 rounded-lg border border-dark-600/50 text-xs text-dark-400 space-y-0.5">
                    <p>
                      <span className="text-dark-300">Provider:</span> {sel.provider}
                    </p>
                    <p>
                      <span className="text-dark-300">Model:</span>{' '}
                      <span className="font-mono">{sel.model}</span>
                    </p>
                    {sel.endpoint && (
                      <p>
                        <span className="text-dark-300">Endpoint:</span>{' '}
                        <span className="font-mono">{sel.endpoint}</span>
                      </p>
                    )}
                    {sel.isReasoning && (
                      <p>
                        <span className="text-dark-300">Reasoning:</span> Yes
                      </p>
                    )}
                    {sel.contextSize && (
                      <p>
                        <span className="text-dark-300">Context:</span>{' '}
                        {(sel.contextSize / 1000).toFixed(0)}k tokens
                      </p>
                    )}
                    {sel.maxOutputTokens && (
                      <p>
                        <span className="text-dark-300">Max Output:</span>{' '}
                        {(sel.maxOutputTokens / 1000).toFixed(0)}k tokens
                      </p>
                    )}
                    {sel.temperature != null && (
                      <p>
                        <span className="text-dark-300">Temperature:</span> {sel.temperature}
                      </p>
                    )}
                  </div>
                ) : null;
              })()}
            <p className="text-[11px] text-dark-500 mt-1">
              LLM configurations are managed in Admin Settings
            </p>
          </div>
        )}

        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Color</label>
          <input
            type="color"
            value={form.color}
            onChange={e => updateField('color', e.target.value)}
            className="h-9 w-full rounded-lg border border-dark-600 cursor-pointer bg-dark-800"
          />
        </div>
      </div>

      {/* Board */}
      <div className="px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <label className="block text-xs text-dark-400 mb-1.5">Board</label>
        <select
          value={form.boardId}
          onChange={e => updateField('boardId', e.target.value)}
          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
        >
          <option value="">No board (visible to all)</option>
          {boards.map(b => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-dark-500 mt-1">
          Agents are visible to all users who have access to the selected board. An agent without a
          board is visible to everyone.
        </p>
      </div>

      {/* TTS toggle — only shown when the global TTS service is configured.
          When enabled, the agent's text-chat replies are spoken aloud. */}
      {!agent.isVoice && (
        <div className="flex items-center justify-between px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
          <div>
            <span className="text-sm text-dark-200">Text-to-Speech (TTS)</span>
            <p className="text-[11px] text-dark-500 mt-0.5">
              {ttsAvailable
                ? 'Speak the assistant replies aloud using the configured TTS service.'
                : 'TTS service is not configured. Set it in Admin Settings → Text-to-Speech (TTS) Service.'}
            </p>
          </div>
          <button
            disabled={!ttsAvailable}
            onClick={async () => {
              if (!ttsAvailable) return;
              const newVal = !form.ttsEnabled;
              updateField('ttsEnabled', newVal);
              try {
                await api.updateAgent(agent.id, { ttsEnabled: newVal });
                onRefresh();
              } catch (err) {
                console.error(err);
                updateField('ttsEnabled', !newVal);
              }
            }}
            className={`relative w-10 h-5 rounded-full transition-colors ${form.ttsEnabled ? 'bg-indigo-500' : 'bg-dark-600'} ${!ttsAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
            title={ttsAvailable ? 'Toggle TTS' : 'TTS service not configured'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${form.ttsEnabled ? 'translate-x-5' : ''}`}
            />
          </button>
        </div>
      )}

      {/* Metrics */}
      <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <h4 className="text-xs font-medium text-dark-300 mb-2">Metrics</h4>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <p className="text-dark-500">Messages</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalMessages || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Tokens In</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalTokensIn || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Tokens Out</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalTokensOut || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Errors</p>
            <p className="font-mono text-dark-200">{agent.metrics?.errors || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Last Active</p>
            <p className="font-mono text-dark-200 text-[10px]">
              {agent.metrics?.lastActiveAt
                ? new Date(agent.metrics.lastActiveAt).toLocaleTimeString()
                : 'Never'}
            </p>
          </div>
          <div>
            <p className="text-dark-500">Created</p>
            <p className="font-mono text-dark-200 text-[10px]">
              {/* Agent.createdAt is optional on the wire; `?? NaN` keeps the
                  existing 'Invalid Date' output for an agent that has none,
                  which is exactly what `new Date(undefined)` already rendered. */}
              {new Date(agent.createdAt ?? NaN).toLocaleDateString()}
            </p>
          </div>
        </div>
      </div>

      {(form.runner === 'codex' || resolveAutoRunner(form.llmConfigId) === 'codex') && (
        // AppUser carries no `id` (App.tsx:17 builds it with `userId` only), so the
        // `currentUser?.id ||` term this expression used to start with was always
        // undefined; it is dropped rather than typed into existence.
        <CodexAuthSection
          ownerId={agent.ownerId || currentUser?.userId}
          currentUser={currentUser}
        />
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        >
          {saving ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : saved ? (
            <>
              <span className="text-emerald-300">&#10003;</span> Saved!
            </>
          ) : (
            <>
              <Save className="w-4 h-4" /> Save Changes
            </>
          )}
        </button>
        <button
          onClick={async () => {
            if (
              !confirm(
                'Reload agent context? This stops the agent and invalidates every cache (conversation, runner sessions, MCP connections, LLM config, file tree) so the next message picks up your latest configuration.'
              )
            )
              return;
            await api.reloadContext(agent.id);
            onRefresh();
          }}
          className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded-lg text-sm font-medium transition-colors"
          title="Reload context — invalidate all caches (conversation, model info, MCP, file tree) to apply config changes"
        >
          <RotateCw className="w-4 h-4" />
        </button>
        <button
          onClick={async () => {
            if (
              !confirm(
                'Restart agent? This restarts the CLI process, reconnects MCP and refreshes the file tree to apply config changes, while KEEPING the conversation so the agent resumes exactly where it left off.'
              )
            )
              return;
            await api.restartRuntime(agent.id);
            onRefresh();
          }}
          className="px-4 py-2 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/20 rounded-lg text-sm font-medium transition-colors"
          title="Restart — reset the runtime (CLI, MCP, file tree) and apply config changes while keeping the conversation so the agent resumes where it left off"
        >
          <Power className="w-4 h-4" />
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-sm font-medium transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
