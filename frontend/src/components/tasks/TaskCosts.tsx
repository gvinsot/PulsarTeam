import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, Clock, Coins, Cpu, Info, Loader2 } from 'lucide-react';
import { api, getTaskCosts } from '../../api';
import { errorMessage } from '../../utils/errors';
import type { TaskCostSummary } from '../../types';

// The "Costs" tab of the task modal: tokens, spend (in the currency chosen in
// Settings → General) and agent time attributed to the task, per agent.
// Data: GET /api/tasks/:id/costs (api/src/services/taskCosts.ts).

interface TaskCostsProps {
  taskId: string;
  /** Changes whenever the task does (e.g. its updatedAt / history length), so
   *  the summary refetches after a run ends without polling. */
  refreshKey?: string | number | null;
}

function formatDuration(ms: number) {
  if (ms <= 0) return '0s';
  if (ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

/** Small amounts keep 4 decimals, like the Budget dashboard. */
const formatCost = (currency: string, n: number) =>
  `${currency}${n >= 100 ? n.toFixed(2) : n.toFixed(4)}`;

// The currency is a global setting that rarely changes: fetch it once per page.
let currencyPromise: Promise<string> | null = null;
function loadCurrency(): Promise<string> {
  currencyPromise ??= api
    .getSettings()
    .then(s => s?.currency || '$')
    .catch(() => {
      currencyPromise = null;
      return '$';
    });
  return currencyPromise;
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="rounded-lg border border-dark-700 bg-dark-800/50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-dark-500 font-semibold">
        <Icon className={`w-3 h-3 ${accent}`} />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-dark-100 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-dark-400 tabular-nums">{sub}</div>}
    </div>
  );
}

export default function TaskCosts({ taskId, refreshKey }: TaskCostsProps) {
  const [summary, setSummary] = useState<TaskCostSummary | null>(null);
  const [currency, setCurrency] = useState('$');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadCurrency().then(c => {
      if (!cancelled) setCurrency(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTaskCosts(taskId)
      .then(data => {
        if (cancelled) return;
        setSummary(data);
        setError(null);
      })
      .catch(err => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (loading && !summary) {
    return (
      <div className="flex items-center gap-2 text-xs text-dark-400 py-6 justify-center">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading costs…
      </div>
    );
  }
  if (error && !summary) {
    return (
      <p className="flex items-center gap-2 text-xs text-red-400 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
        {error}
      </p>
    );
  }
  if (!summary) return null;

  const { totals, byAgent, running } = summary;
  const totalTokens = totals.inputTokens + totals.outputTokens;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <StatTile
          icon={Cpu}
          label="Tokens"
          value={formatTokens(totalTokens)}
          sub={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
          accent="text-indigo-400"
        />
        <StatTile
          icon={Coins}
          label={`Cost (${currency})`}
          value={formatCost(currency, totals.cost)}
          sub={`${totals.requests} request${totals.requests === 1 ? '' : 's'}`}
          accent="text-emerald-400"
        />
        <StatTile
          icon={Clock}
          label="Agent time"
          value={formatDuration(totals.timeMs)}
          sub={`${totals.runs} run${totals.runs === 1 ? '' : 's'}`}
          accent="text-amber-400"
        />
      </div>

      {byAgent.length === 0 ? (
        <p className="text-xs text-dark-500 text-center py-4">
          No agent has worked on this task yet.
        </p>
      ) : (
        <div className="rounded-lg border border-dark-700 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-dark-800/60 text-dark-400">
              <tr>
                <th className="text-left font-medium px-3 py-2">Agent</th>
                <th className="text-right font-medium px-3 py-2">Input</th>
                <th className="text-right font-medium px-3 py-2">Output</th>
                <th className="text-right font-medium px-3 py-2">Cost</th>
                <th className="text-right font-medium px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-800">
              {byAgent.map(a => (
                <tr key={a.agentId || a.agentName} className="text-dark-200">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Bot className="w-3 h-3 text-purple-400 flex-shrink-0" />
                      <span className="truncate">{a.agentName}</span>
                      {a.estimated && (
                        <span
                          className="text-amber-400"
                          title="Part of this usage predates per-task tracking and was matched by the agent's run times"
                        >
                          ≈
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatTokens(a.inputTokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatTokens(a.outputTokens)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCost(currency, a.cost)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDuration(a.timeMs)}
                    {a.runs > 0 && <span className="text-dark-500"> · {a.runs}×</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(running || totals.estimated) && (
        <div className="space-y-1">
          {running && (
            <p className="flex items-center gap-1.5 text-[11px] text-dark-400">
              <Info className="w-3 h-3 flex-shrink-0" />
              An agent is working on this task: the current run's time is added when it ends.
            </p>
          )}
          {totals.estimated && (
            <p className="flex items-center gap-1.5 text-[11px] text-dark-400">
              <Info className="w-3 h-3 flex-shrink-0" />≈ Estimated: usage recorded before per-task
              tracking is matched by run times.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
