import { useState, useEffect, useCallback } from 'react';
import {
  fetchBudgetSummary, fetchBudgetByAgent, fetchBudgetTimeline,
  fetchBudgetDaily, fetchBudgetConfig, updateBudgetConfig, fetchBudgetAlerts, api
} from '../api';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, ArcElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler);

const COLORS = ['#6366f1','#22d3ee','#f59e0b','#ef4444','#10b981','#8b5cf6','#f97316','#ec4899','#14b8a6','#a855f7'];

export default function BudgetDashboard({ agents = [] }) {
  const [summary, setSummary] = useState(null);
  const [byAgent, setByAgent] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [daily, setDaily] = useState([]);
  const [config, setConfig] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState(7);
  const [showSettings, setShowSettings] = useState(false);
  const [editConfig, setEditConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [currency, setCurrency] = useState('$');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, t, d, c, al, settings] = await Promise.all([
        fetchBudgetSummary(1), fetchBudgetByAgent(timeRange),
        fetchBudgetTimeline(timeRange, timeRange <= 2 ? 'hour' : 'day'),
        fetchBudgetDaily(30), fetchBudgetConfig(), fetchBudgetAlerts(),
        api.getSettings(),
      ]);
      setSummary(s); setByAgent(a); setTimeline(t); setDaily(d); setConfig(c); setAlerts(al);
      if (settings?.currency) setCurrency(settings.currency);
    } catch (err) { console.error('Budget load error:', err); }
    finally { setLoading(false); }
  }, [timeRange]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { const i = setInterval(loadData, 30000); return () => clearInterval(i); }, [loadData]);

  const handleSaveConfig = async () => {
    setSaving(true);
    try { await updateBudgetConfig(editConfig); setConfig(editConfig); setShowSettings(false); loadData(); }
    catch (err) { console.error('Save config error:', err); }
    finally { setSaving(false); }
  };

  const todayCost = summary?.total_cost || 0;
  const dailyBudget = config?.dailyBudget || 0;
  const budgetPct = dailyBudget > 0 ? Math.min((todayCost / dailyBudget) * 100, 100) : 0;
  const budgetColor = budgetPct >= 100 ? 'bg-red-500' : budgetPct >= 80 ? 'bg-yellow-500' : 'bg-green-500';

  const dailyChartData = {
    labels: daily.map(d => d.day?.slice(5) || ''),
    datasets: [
      { label: `Cost (${currency})`, data: daily.map(d => d.cost || 0), borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.15)', fill: true, tension: 0.3 },
      ...(dailyBudget > 0 ? [{ label: 'Budget', data: daily.map(() => dailyBudget), borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, fill: false }] : []),
    ],
  };

  const agentNames = [...new Set(timeline.map(t => t.agent_name))];
  const periods = [...new Set(timeline.map(t => t.period))];
  const timelineChartData = {
    labels: periods.map(p => p?.slice(5) || ''),
    datasets: agentNames.map((name, i) => ({
      label: name,
      data: periods.map(p => { const e = timeline.find(t => t.period === p && t.agent_name === name); return e ? (e.input_tokens + e.output_tokens) / 1000 : 0; }),
      borderColor: COLORS[i % COLORS.length], backgroundColor: COLORS[i % COLORS.length] + '33', fill: false, tension: 0.3,
    })),
  };

  const agentCostData = {
    labels: byAgent.map(a => a.model || a.provider || 'Unknown'),
    datasets: [{ data: byAgent.map(a => a.total_cost || 0), backgroundColor: byAgent.map((_, i) => COLORS[i % COLORS.length]), borderWidth: 0 }],
  };

  const chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
    scales: { x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } } },
  };
  const doughnutOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 11 }, padding: 12 } } } };

  if (loading && !summary) return <div className="p-6 text-dark-400">Loading budget data...</div>;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-dark-100">💰 Budget Dashboard</h1>
          <p className="text-sm text-dark-400 mt-1">AI agent token usage & cost tracking</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={timeRange} onChange={e => setTimeRange(Number(e.target.value))} className="bg-dark-800 border border-dark-600 text-dark-200 rounded px-3 py-1.5 text-sm">
            <option value={1}>Last 24h</option><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option>
          </select>
          <button onClick={() => { setEditConfig({ ...config }); setShowSettings(true); }} className="bg-dark-700 hover:bg-dark-600 text-dark-200 px-3 py-1.5 rounded text-sm">⚙️ Settings</button>
          <button onClick={loadData} className="bg-dark-700 hover:bg-dark-600 text-dark-200 px-3 py-1.5 rounded text-sm">🔄</button>
        </div>
      </div>

      {/* Alerts */}
      {alerts?.alerts?.length > 0 && (
        <div className="space-y-2">
          {alerts.alerts.map((a, i) => (
            <div key={i} className={`px-4 py-3 rounded-lg text-sm font-medium ${a.level === 'critical' ? 'bg-red-900/40 text-red-300 border border-red-800' : 'bg-yellow-900/40 text-yellow-300 border border-yellow-800'}`}>
              {a.level === 'critical' ? '🚨' : '⚠️'} {a.message}
            </div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
          <div className="text-xs text-dark-400 uppercase tracking-wider mb-1">Today's Cost</div>
          <div className="text-2xl font-bold text-dark-100">{currency}{todayCost.toFixed(4)}</div>
          {dailyBudget > 0 && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-dark-400 mb-1"><span>{budgetPct.toFixed(0)}% of budget</span><span>{currency}{dailyBudget.toFixed(2)}</span></div>
              <div className="h-2 bg-dark-700 rounded-full overflow-hidden"><div className={`h-full ${budgetColor} rounded-full transition-all`} style={{ width: `${budgetPct}%` }} /></div>
            </div>
          )}
        </div>
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
          <div className="text-xs text-dark-400 uppercase tracking-wider mb-1">Today's Tokens</div>
          <div className="text-2xl font-bold text-dark-100">{((summary?.total_input || 0) + (summary?.total_output || 0)).toLocaleString()}</div>
          <div className="text-xs text-dark-400 mt-1">In: {(summary?.total_input || 0).toLocaleString()} · Out: {(summary?.total_output || 0).toLocaleString()}</div>
        </div>
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
          <div className="text-xs text-dark-400 uppercase tracking-wider mb-1">API Calls Today</div>
          <div className="text-2xl font-bold text-dark-100">{(summary?.total_calls || 0).toLocaleString()}</div>
          <div className="text-xs text-dark-400 mt-1">Avg: {currency}{summary?.total_calls ? (todayCost / summary.total_calls).toFixed(6) : '0'}/call</div>
        </div>
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
          <div className="text-xs text-dark-400 uppercase tracking-wider mb-1">Active Agents</div>
          <div className="text-2xl font-bold text-dark-100">{byAgent.length}</div>
          <div className="text-xs text-dark-400 mt-1">Top: {byAgent[0]?.model || 'N/A'}</div>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-dark-200 mb-3">📈 Daily Cost Trend (30 days)</h3>
          <div className="h-64">{daily.length > 0 ? <Line data={dailyChartData} options={chartOpts} /> : <div className="h-full flex items-center justify-center text-dark-500 text-sm">No data yet</div>}</div>
        </div>
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-dark-200 mb-3">🍩 Cost by LLM ({timeRange}d)</h3>
          <div className="h-64">{byAgent.length > 0 ? <Doughnut data={agentCostData} options={doughnutOpts} /> : <div className="h-full flex items-center justify-center text-dark-500 text-sm">No data yet</div>}</div>
        </div>
      </div>

      <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-dark-200 mb-3">📊 Token Usage per Agent ({timeRange}d, K tokens)</h3>
        <div className="h-72">{timeline.length > 0 ? <Line data={timelineChartData} options={chartOpts} /> : <div className="h-full flex items-center justify-center text-dark-500 text-sm">No data yet</div>}</div>
      </div>

      {/* Agent table */}
      <div className="bg-dark-900 border border-dark-700/50 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-dark-700/50"><h3 className="text-sm font-semibold text-dark-200">🤖 LLM Breakdown ({timeRange} days)</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-dark-800">
              <tr>
                <th className="text-left px-4 py-2 text-dark-400 font-medium">Provider</th>
                <th className="text-left px-4 py-2 text-dark-400 font-medium">Model</th>
                <th className="text-right px-4 py-2 text-dark-400 font-medium">Agents</th>
                <th className="text-right px-4 py-2 text-dark-400 font-medium">Input Tokens</th>
                <th className="text-right px-4 py-2 text-dark-400 font-medium">Output Tokens</th>
                <th className="text-right px-4 py-2 text-dark-400 font-medium">Total Cost</th>
                <th className="text-right px-4 py-2 text-dark-400 font-medium">Calls</th>
                <th className="text-right px-4 py-2 text-dark-400 font-medium">Avg/call</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-dark-500">No usage data yet</td></tr>
              ) : byAgent.map((a, i) => (
                <tr key={`${a.provider}-${a.model}`} className="border-t border-dark-800 hover:bg-dark-800/50">
                  <td className="px-4 py-2 text-dark-200 font-medium"><span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: COLORS[i % COLORS.length] }} />{a.provider || '-'}</td>
                  <td className="px-4 py-2 text-dark-300 font-mono text-xs">{a.model || '-'}</td>
                  <td className="text-right px-4 py-2 text-dark-400">{a.agent_count || 1}</td>
                  <td className="text-right px-4 py-2 text-dark-300">{(a.total_input || 0).toLocaleString()}</td>
                  <td className="text-right px-4 py-2 text-dark-300">{(a.total_output || 0).toLocaleString()}</td>
                  <td className="text-right px-4 py-2 text-green-400 font-medium">{currency}{(a.total_cost || 0).toFixed(4)}</td>
                  <td className="text-right px-4 py-2 text-dark-300">{a.request_count || 0}</td>
                  <td className="text-right px-4 py-2 text-dark-400">{currency}{a.request_count ? (a.total_cost / a.request_count).toFixed(6) : '0'}</td>
                </tr>
              ))}
              {byAgent.length > 0 && (
                <tr className="border-t-2 border-dark-600 bg-dark-800/30 font-medium">
                  <td className="px-4 py-2 text-dark-200">Total</td><td /><td />
                  <td className="text-right px-4 py-2 text-dark-200">{byAgent.reduce((s,a) => s + (a.total_input||0), 0).toLocaleString()}</td>
                  <td className="text-right px-4 py-2 text-dark-200">{byAgent.reduce((s,a) => s + (a.total_output||0), 0).toLocaleString()}</td>
                  <td className="text-right px-4 py-2 text-green-400">{currency}{byAgent.reduce((s,a) => s + (a.total_cost||0), 0).toFixed(4)}</td>
                  <td className="text-right px-4 py-2 text-dark-200">{byAgent.reduce((s,a) => s + (a.request_count||0), 0)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Settings modal */}
      {showSettings && editConfig && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-dark-900 border border-dark-700 rounded-lg w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-dark-100">Budget Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-dark-400 hover:text-dark-200">✕</button>
            </div>
            <div>
              <label className="block text-sm text-dark-400 mb-1">Daily Budget ({currency})</label>
              <input type="number" step="0.01" value={editConfig.dailyBudget || 0} onChange={e => setEditConfig({ ...editConfig, dailyBudget: parseFloat(e.target.value) || 0 })} className="w-full bg-dark-800 border border-dark-600 rounded px-3 py-2 text-sm text-dark-200" />
            </div>
            <div>
              <label className="block text-sm text-dark-400 mb-1">Alert Threshold (%)</label>
              <input type="number" min={0} max={100} value={editConfig.alertThreshold || 80} onChange={e => setEditConfig({ ...editConfig, alertThreshold: parseInt(e.target.value) || 80 })} className="w-full bg-dark-800 border border-dark-600 rounded px-3 py-2 text-sm text-dark-200" />
              <p className="text-xs text-dark-500 mt-1">Alert when daily spend exceeds this % of budget</p>
            </div>
          <div className="bg-dark-800/50 rounded-xl border border-dark-700/50 p-4">
            <p className="text-xs text-dark-400">Token costs are managed via LLM configurations in <span className="text-primary-400">Admin Settings</span>.</p>
          </div>
                    <div className="flex-1">
                      <input type="number" step="0.01" value={costs.output} onChange={e => setEditConfig({ ...editConfig, tokenCosts: { ...editConfig.tokenCosts, [provider]: { ...costs, output: parseFloat(e.target.value) || 0 } } })} className="w-full bg-dark-800 border border-dark-600 rounded px-2 py-1 text-xs text-dark-200" />
                      <span className="text-[10px] text-dark-500">output</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowSettings(false)} className="px-4 py-2 bg-dark-700 text-dark-300 rounded text-sm">Cancel</button>
              <button onClick={handleSaveConfig} disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}