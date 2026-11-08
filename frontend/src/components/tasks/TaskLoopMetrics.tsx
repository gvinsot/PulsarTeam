import { useEffect, useState } from 'react';
import { Activity, Bell, Gauge, Wrench } from 'lucide-react';
import { getTaskLoopMetrics } from '../../api';
import type { TaskLoopMetrics as LoopMetrics } from '../../types';

// "Agent loop" section of the task Costs tab: indicators of the native agentic
// loop run by sandbox agents (turns, tool calls, failures, tokens, reminders,
// share of the context used by tool results). Hidden when no native turn ran.
// Data: GET /api/tasks/:id/loop-metrics (api/src/services/agentManager/loopMetrics.ts).

interface TaskLoopMetricsProps {
  taskId: string;
  refreshKey?: string | number | null;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

const formatTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

const lotsLabel = (lots: number[][]) =>
  lots.map(l => (l.length ? `lots ${l.join('+')}` : 'baseline')).join(', ');

function Tile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-dark-700 bg-dark-800/50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-dark-500 font-semibold">
        <Icon className="w-3 h-3 text-sky-400" />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-dark-100 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-dark-400 tabular-nums">{sub}</div>}
    </div>
  );
}

export default function TaskLoopMetrics({ taskId, refreshKey }: TaskLoopMetricsProps) {
  const [metrics, setMetrics] = useState<LoopMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTaskLoopMetrics(taskId)
      .then(data => {
        if (!cancelled) setMetrics(data);
      })
      // Optional section: the Costs tab above already reports load errors.
      .catch(() => {
        if (!cancelled) setMetrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (!metrics || metrics.turns === 0) return null;

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-dark-300">Agent loop</h4>
        <span className="text-[11px] text-dark-500">{lotsLabel(metrics.lots)}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Tile
          icon={Activity}
          label="Turns"
          value={String(metrics.turns)}
          sub={`${metrics.llmCalls} model calls · ${metrics.toolRounds} tool rounds`}
        />
        <Tile
          icon={Wrench}
          label="Tool calls"
          value={String(metrics.toolCalls)}
          sub={`${metrics.failedToolCalls} failed · ${metrics.truncatedToolCalls} truncated`}
        />
        <Tile
          icon={Bell}
          label="Reminders"
          value={String(metrics.reminders)}
          sub={`${formatTokens(metrics.inputTokens)} in · ${formatTokens(metrics.outputTokens)} out`}
        />
        <Tile
          icon={Gauge}
          label="Tool context"
          value={pct(metrics.avgToolContextShare)}
          sub={`peak ${pct(metrics.peakToolContextShare)}`}
        />
      </div>
      {metrics.byTool.length > 0 && (
        <div className="rounded-lg border border-dark-700 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-dark-800/60 text-dark-400">
              <tr>
                <th className="text-left font-medium px-3 py-2">Tool</th>
                <th className="text-right font-medium px-3 py-2">Calls</th>
                <th className="text-right font-medium px-3 py-2">Errors</th>
                <th className="text-right font-medium px-3 py-2">Avg</th>
                <th className="text-right font-medium px-3 py-2">Max</th>
                <th className="text-right font-medium px-3 py-2">Truncated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-800">
              {metrics.byTool.map(t => (
                <tr key={t.name} className="text-dark-200">
                  <td className="px-3 py-2 font-mono">{t.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.calls}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {t.failures} <span className="text-dark-500">({pct(t.errorRate)})</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMs(t.avgMs)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMs(t.maxMs)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.truncated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
