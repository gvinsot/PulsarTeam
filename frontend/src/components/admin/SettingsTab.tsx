import { useState, useEffect, useCallback } from 'react';
import {
  Save, AlertCircle, Cpu, Bell, RotateCcw, Mic, Volume2, Plug, CheckCircle2,
} from 'lucide-react';
import { api } from '../../api';

// `active` flips true when the Settings tab is selected; each activation
// re-fetches settings, reminder config, reset roles and LLM configs.
export default function SettingsTab({ active, showToast }) {
  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [customCurrency, setCustomCurrency] = useState('');

  // Reminder config state
  const [reminderConfig, setReminderConfig] = useState(null);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderSaving, setReminderSaving] = useState(false);

  // Reset instructions state
  const [resetRole, setResetRole] = useState('');
  const [resetRoles, setResetRoles] = useState([]);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  // LLM configs (for the Code Graph / Claude fallback LLM pickers)
  const [llmConfigs, setLlmConfigs] = useState([]);

  // Voice services (STT/TTS) connection test state
  const [voiceTest, setVoiceTest] = useState<{ stt: any; tts: any }>({ stt: null, tts: null });
  const [voiceTesting, setVoiceTesting] = useState<{ stt: boolean; tts: boolean }>({ stt: false, tts: false });

  const handleTestVoiceService = useCallback(async (service: 'stt' | 'tts') => {
    setVoiceTesting(s => ({ ...s, [service]: true }));
    setVoiceTest(s => ({ ...s, [service]: null }));
    try {
      const url = service === 'stt' ? settings?.sttServiceUrl : settings?.ttsServiceUrl;
      const apiKey = service === 'stt' ? settings?.sttApiKey : settings?.ttsApiKey;
      const result = await api.testExternalVoiceService(service, url, apiKey);
      setVoiceTest(s => ({ ...s, [service]: result }));
      if (result?.ok) {
        showToast?.(`${service.toUpperCase()} connected${result.latencyMs != null ? ` (${result.latencyMs} ms)` : ''}`, 'success');
      } else {
        showToast?.(`${service.toUpperCase()} test failed: ${result?.error || 'unknown error'}`, 'error');
      }
    } catch (err: any) {
      setVoiceTest(s => ({ ...s, [service]: { ok: false, error: err.message } }));
      showToast?.(`${service.toUpperCase()} test failed: ${err.message}`, 'error');
    } finally {
      setVoiceTesting(s => ({ ...s, [service]: false }));
    }
  }, [settings, showToast]);

  const loadSettings = useCallback(async () => {
    try {
      setSettingsLoading(true);
      const data = await api.getSettings();
      setSettings(data);
      const known = ['$', '€', '£'];
      if (data.currency && !known.includes(data.currency)) {
        setCustomCurrency(data.currency);
      }
    } catch (err) {
      showToast?.(`Failed to load settings: ${err.message}`, 'error');
    } finally {
      setSettingsLoading(false);
    }
  }, [showToast]);

  const loadReminderConfig = useCallback(async () => {
    try {
      setReminderLoading(true);
      const data = await api.getReminderConfig();
      setReminderConfig(data);
    } catch (err) {
      showToast?.(`Failed to load reminder config: ${err.message}`, 'error');
    } finally {
      setReminderLoading(false);
    }
  }, [showToast]);

  const loadResetRoles = useCallback(async () => {
    try {
      const templates = await api.getTemplates();
      const roles = [...new Set(templates.map(t => t.role).filter(Boolean))];
      setResetRoles(roles);
    } catch { /* ignore */ }
  }, []);

  const loadLlmConfigs = useCallback(async () => {
    try {
      const data = await api.getLlmConfigs();
      setLlmConfigs(data);
    } catch (err) {
      showToast?.(`Failed to load LLM configs: ${err.message}`, 'error');
    }
  }, [showToast]);

  useEffect(() => {
    if (active) { loadSettings(); loadReminderConfig(); loadResetRoles(); loadLlmConfigs(); }
  }, [active, loadSettings, loadReminderConfig, loadResetRoles, loadLlmConfigs]);

  const handleSaveSettings = async () => {
    try {
      setSettingsSaving(true);
      const updated = await api.updateSettings(settings);
      setSettings(updated);
      if (reminderConfig) {
        setReminderSaving(true);
        const updatedReminder = await api.updateReminderConfig(reminderConfig);
        setReminderConfig(updatedReminder);
      }
      showToast?.('Settings saved', 'success');
    } catch (err) {
      showToast?.(`Failed to save settings: ${err.message}`, 'error');
    } finally {
      setSettingsSaving(false);
      setReminderSaving(false);
    }
  };

  return (
    settingsLoading ? (
      <div className="text-center py-8">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    ) : settings ? (
      <div className="space-y-6">
        {/* Currency */}
        <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
              <span className="text-lg">💱</span> Currency
            </h4>
            <p className="text-xs text-dark-400 mt-1">
              Currency symbol used across the Budget dashboard and cost displays.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { value: '$', label: 'USD ($)' },
              { value: '€', label: 'EUR (€)' },
              { value: '£', label: 'GBP (£)' },
              { value: '¥', label: 'JPY (¥)' },
              { value: 'CHF', label: 'CHF' },
              { value: 'custom', label: 'Custom…' },
            ].map(opt => {
              const isCustom = opt.value === 'custom';
              const isActive = isCustom
                ? !['$', '€', '£', '¥', 'CHF'].includes(settings.currency)
                : settings.currency === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => {
                    if (isCustom) {
                      setSettings(s => ({ ...s, currency: customCurrency || '₿' }));
                    } else {
                      setSettings(s => ({ ...s, currency: opt.value }));
                      setCustomCurrency('');
                    }
                  }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    isActive
                      ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                      : 'bg-dark-900 border-dark-600 text-dark-400 hover:text-dark-200 hover:border-dark-500'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {!['$', '€', '£', '¥', 'CHF'].includes(settings.currency) && (
            <div className="flex items-center gap-3">
              <label className="text-xs text-dark-400">Custom symbol:</label>
              <input
                type="text"
                value={settings.currency || ''}
                onChange={e => {
                  const v = e.target.value.slice(0, 5);
                  setSettings(s => ({ ...s, currency: v }));
                  setCustomCurrency(v);
                }}
                className="w-24 px-3 py-1.5 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="₿"
              />
              <span className="text-xs text-dark-500">Preview: {settings.currency}1,234.56</span>
            </div>
          )}
        </div>

        {/* Task Reminders */}
        <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
              <Bell className="w-4 h-4 text-amber-400" />
              Task Reminders
            </h4>
            <p className="text-xs text-dark-400 mt-1">
              Configure how agents are reminded to complete their active tasks.
            </p>
          </div>
          {reminderLoading ? (
            <div className="text-center py-4">
              <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : reminderConfig ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-dark-400 mb-1">Interval (minutes)</label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={reminderConfig.intervalMinutes ?? 10}
                  onChange={e => setReminderConfig(c => ({ ...c, intervalMinutes: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                  className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[10px] text-dark-500 mt-1">Time between each reminder</p>
              </div>
              <div>
                <label className="block text-xs text-dark-400 mb-1">Max reminders</label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={reminderConfig.maxReminders ?? 12}
                  onChange={e => setReminderConfig(c => ({ ...c, maxReminders: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                  className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[10px] text-dark-500 mt-1">Max attempts before giving up</p>
              </div>
              <div>
                <label className="block text-xs text-dark-400 mb-1">Cooldown (minutes)</label>
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={reminderConfig.cooldownMinutes ?? 2}
                  onChange={e => setReminderConfig(c => ({ ...c, cooldownMinutes: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[10px] text-dark-500 mt-1">Min wait after a reminder before next</p>
              </div>
            </div>
          ) : (
            <div className="text-xs text-dark-500">Failed to load reminder configuration</div>
          )}
          {reminderConfig?.envOverride && (
            <div className="text-xs px-3 py-2 rounded-lg bg-amber-900/20 text-amber-400 border border-amber-800/30">
              Interval is overridden by the TASK_REMINDER_INTERVAL_MINUTES environment variable.
            </div>
          )}
        </div>

        {/* Code Graph LLM */}
        <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-purple-400" />
              Code Graph LLM
            </h4>
            <p className="text-xs text-dark-400 mt-1">
              Optional LLM used to simplify the repository call-graph analysis
              (UI ↔ services). When unset, the graph is built deterministically
              from source-file parsing only.
            </p>
          </div>
          <select
            value={settings.codeGraphLlmConfigId || ''}
            onChange={e => setSettings(s => ({ ...s, codeGraphLlmConfigId: e.target.value }))}
            className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="">— None (parse only, no LLM) —</option>
            {llmConfigs.map(c => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.provider}/{c.model})
              </option>
            ))}
          </select>
        </div>

        {/* Claude Paid Plan — Fallback LLM */}
        <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-orange-400" />
              Claude Paid Plan — Interactive Fallback LLM
            </h4>
            <p className="text-xs text-dark-400 mt-1">
              The Claude CLI is driven through a PTY (no <code>-p</code>) to keep
              subscription pricing. When the TUI shows a Y/N or list prompt
              we don't have a hardcoded answer for, this LLM is consulted to
              choose the safest option. Leave unset to fall back to safe
              defaults ("y" / first option).
            </p>
          </div>
          <select
            value={settings.claudeFallbackLlmConfigId || ''}
            onChange={e => setSettings(s => ({ ...s, claudeFallbackLlmConfigId: e.target.value }))}
            className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="">— None (use safe defaults) —</option>
            {llmConfigs.map(c => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.provider}/{c.model})
              </option>
            ))}
          </select>
        </div>

        {/* Speech-to-Text (STT) service */}
        <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
                <Mic className="w-4 h-4 text-emerald-400" />
                Speech-to-Text (STT) Service
              </h4>
              <p className="text-xs text-dark-400 mt-1">
                The browser streams microphone audio (PCM16 mono @ 16 kHz) to this WebSocket
                and receives transcripts back. Used both in regular agent chat (mic input)
                and by external-voice agents. Compatible with{' '}
                <a className="underline" href="https://speech-ui.methodinfo.fr/" target="_blank" rel="noreferrer">HighSpeedToText</a>.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleTestVoiceService('stt')}
              disabled={voiceTesting.stt || !settings.sttServiceUrl}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {voiceTesting.stt ? (
                <div className="w-3.5 h-3.5 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin" />
              ) : (
                <Plug className="w-3.5 h-3.5" />
              )}
              Test connection
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-dark-400 mb-1">STT WebSocket URL</label>
              <input
                type="text"
                value={settings.sttServiceUrl || ''}
                onChange={e => setSettings(s => ({ ...s, sttServiceUrl: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono"
                placeholder="wss://speech.methodinfo.fr/v1/ws/transcribe"
              />
              <p className="text-[10px] text-dark-500 mt-1">Provider can be different from TTS.</p>
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">STT API Key</label>
              <input
                type="password"
                value={settings.sttApiKey || ''}
                onChange={e => setSettings(s => ({ ...s, sttApiKey: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono"
                placeholder="sk_..."
              />
              <p className="text-[10px] text-dark-500 mt-1">Injected as <code>?api_key=…</code> when the browser opens the WS.</p>
            </div>
          </div>
          {voiceTest.stt && (
            <div
              className={`text-xs px-3 py-2 rounded-lg border flex items-center gap-2 ${
                voiceTest.stt.ok
                  ? 'bg-emerald-900/20 text-emerald-300 border-emerald-800/40'
                  : 'bg-red-900/20 text-red-300 border-red-800/40'
              }`}
            >
              {voiceTest.stt.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              <span>
                {voiceTest.stt.ok
                  ? `Connected${voiceTest.stt.latencyMs != null ? ` in ${voiceTest.stt.latencyMs} ms` : ''}.`
                  : `Failed: ${voiceTest.stt.error || 'unknown error'}`}
              </span>
            </div>
          )}
        </div>

        {/* Text-to-Speech (TTS) service */}
        <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-indigo-400" />
                Text-to-Speech (TTS) Service
              </h4>
              <p className="text-xs text-dark-400 mt-1">
                The browser sends text to this WebSocket and streams back PCM16 mono @ 22 050 Hz.
                Used both for spoken-reply in agent chat (when enabled per-agent) and by
                external-voice agents. Can use a different provider from STT.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleTestVoiceService('tts')}
              disabled={voiceTesting.tts || !settings.ttsServiceUrl}
              className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {voiceTesting.tts ? (
                <div className="w-3.5 h-3.5 border-2 border-indigo-300 border-t-transparent rounded-full animate-spin" />
              ) : (
                <Plug className="w-3.5 h-3.5" />
              )}
              Test connection
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-dark-400 mb-1">TTS WebSocket URL</label>
              <input
                type="text"
                value={settings.ttsServiceUrl || ''}
                onChange={e => setSettings(s => ({ ...s, ttsServiceUrl: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono"
                placeholder="wss://speech.methodinfo.fr/v1/ws/synthesize"
              />
              <p className="text-[10px] text-dark-500 mt-1">Provider can be different from STT.</p>
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">TTS API Key</label>
              <input
                type="password"
                value={settings.ttsApiKey || ''}
                onChange={e => setSettings(s => ({ ...s, ttsApiKey: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono"
                placeholder="sk_..."
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-dark-400 mb-1">Default TTS Voice ID</label>
              <input
                type="text"
                value={settings.ttsVoiceId || ''}
                onChange={e => setSettings(s => ({ ...s, ttsVoiceId: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono"
                placeholder="voice-uuid (optional — per-agent ttsVoiceId overrides)"
              />
              <p className="text-[10px] text-dark-500 mt-1">
                Used in <code>session.start</code> as <code>voice_id</code> (zero-shot mode). Per-agent voice IDs can override this default.
              </p>
            </div>
          </div>
          {voiceTest.tts && (
            <div
              className={`text-xs px-3 py-2 rounded-lg border flex items-center gap-2 ${
                voiceTest.tts.ok
                  ? 'bg-emerald-900/20 text-emerald-300 border-emerald-800/40'
                  : 'bg-red-900/20 text-red-300 border-red-800/40'
              }`}
            >
              {voiceTest.tts.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              <span>
                {voiceTest.tts.ok
                  ? `Connected${voiceTest.tts.latencyMs != null ? ` in ${voiceTest.tts.latencyMs} ms` : ''}.`
                  : `Failed: ${voiceTest.tts.error || 'unknown error'}`}
              </span>
            </div>
          )}
        </div>

        {/* Reset Agent Instructions */}
        <div className="p-5 bg-dark-800 rounded-xl border border-dark-700 space-y-4">
          <div>
            <h4 className="text-sm font-semibold text-dark-200 flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-orange-400" />
              Reset Agent Instructions
            </h4>
            <p className="text-xs text-dark-400 mt-1">
              Reset instructions of all agents with a given role back to the default template.
            </p>
          </div>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-dark-400 mb-1">Agent Role</label>
              <select
                value={resetRole}
                onChange={e => { setResetRole(e.target.value); setResetConfirm(false); }}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
              >
                <option value="">Select a role…</option>
                {resetRoles.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            {!resetConfirm ? (
              <button
                onClick={() => setResetConfirm(true)}
                disabled={!resetRole || resetLoading}
                className="flex items-center gap-2 px-4 py-2 bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 border border-orange-500/40 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setResetLoading(true);
                    try {
                      const res = await api.resetInstructionsByRole(resetRole);
                      showToast?.(`Reset ${res.resetCount} agent(s) with role "${resetRole}" to default instructions`, 'success');
                      setResetConfirm(false);
                    } catch (err) {
                      showToast?.(`Reset failed: ${err.message}`, 'error');
                    } finally {
                      setResetLoading(false);
                    }
                  }}
                  disabled={resetLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {resetLoading ? (
                    <div className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5" />
                  )}
                  Confirm Reset
                </button>
                <button
                  onClick={() => setResetConfirm(false)}
                  className="px-3 py-2 text-dark-400 hover:text-dark-200 text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {resetConfirm && resetRole && (
            <div className="text-xs px-3 py-2 rounded-lg bg-red-900/20 text-red-400 border border-red-800/30">
              This will overwrite the instructions of <strong>all agents</strong> with role "{resetRole}" — this cannot be undone.
            </div>
          )}
        </div>

        {/* Save button */}
        <div className="flex justify-end">
          <button
            onClick={handleSaveSettings}
            disabled={settingsSaving || reminderSaving}
            className="flex items-center gap-2 px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {settingsSaving || reminderSaving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    ) : (
      <div className="text-center py-8 text-dark-400">Failed to load settings</div>
    )
  );
}
