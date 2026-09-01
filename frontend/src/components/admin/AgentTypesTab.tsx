import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Bot, Save } from 'lucide-react';
import { api } from '../../api';
import { errorMessage } from '../../utils/errors';
import {
  AGENT_TYPE_DESCRIPTIONS,
  AGENT_TYPE_IDS,
  AGENT_TYPE_LABELS,
  parseDisabledAgentTypes,
  serializeDisabledAgentTypes,
  type AgentTypeId,
} from '../../utils/agentTypes';
import type { ShowToastFn } from '../../types';

interface AgentTypesTabProps {
  active: boolean;
  showToast?: ShowToastFn;
}

/**
 * Global on/off switches for the agent types (runners) users may pick when
 * creating or editing an agent. Backed by the single `disabledAgentTypes`
 * settings row, so a type added by a later release is on by default.
 *
 * Switching a type off hides it from the runner pickers and makes the API
 * reject a create/update that selects it. Agents already running on it keep
 * working — this gates the choice, it does not stop existing agents.
 */
export default function AgentTypesTab({ active, showToast }: AgentTypesTabProps) {
  const [disabled, setDisabled] = useState<Set<AgentTypeId>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const settings = await api.getSettings();
      setDisabled(parseDisabledAgentTypes(settings.disabledAgentTypes));
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      showToast?.(`Failed to load agent types: ${errorMessage(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const toggle = (id: AgentTypeId) =>
    setDisabled(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleSave = async () => {
    try {
      setSaving(true);
      const updated = await api.updateSettings({
        disabledAgentTypes: serializeDisabledAgentTypes(disabled),
      });
      setDisabled(parseDisabledAgentTypes(updated.disabledAgentTypes));
      showToast?.('Agent types saved', 'success');
    } catch (err) {
      showToast?.(`Failed to save agent types: ${errorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const enabledCount = AGENT_TYPE_IDS.length - disabled.size;

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    );
  }

  if (loadFailed) {
    return <div className="text-center py-8 text-dark-400">Failed to load agent types</div>;
  }

  return (
    <div className="space-y-6">
      <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
            <Bot className="w-4 h-4 text-indigo-400" />
            Agent Types
          </h4>
          <p className="text-xs text-dark-400 mt-1">
            Enable or disable the execution backends users can pick for their agents. This applies
            to <strong>all users</strong>. A disabled type disappears from the runner picker and is
            rejected on save — agents already running on it keep working.
          </p>
        </div>

        <div className="space-y-2">
          {AGENT_TYPE_IDS.map(id => {
            const isEnabled = !disabled.has(id);
            return (
              <div
                key={id}
                className="flex items-center justify-between gap-4 px-4 py-3 bg-dark-900 rounded-lg border border-dark-700"
              >
                <div className="min-w-0">
                  <div className="text-sm text-dark-200">{AGENT_TYPE_LABELS[id]}</div>
                  <p className="text-[11px] text-dark-500 mt-0.5">{AGENT_TYPE_DESCRIPTIONS[id]}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  aria-label={AGENT_TYPE_LABELS[id]}
                  onClick={() => toggle(id)}
                  className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                    isEnabled ? 'bg-indigo-500' : 'bg-dark-600'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                      isEnabled ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>

        {enabledCount === 0 && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-900/20 text-amber-400 border border-amber-800/30 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Every agent type is disabled — no new agent can be created until you re-enable one.
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving...' : 'Save Agent Types'}
        </button>
      </div>
    </div>
  );
}
