import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js';
import type { ChartOptions } from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import { fetchAnalyticsBoards, fetchAnalyticsErrors, fetchAnalyticsTasks } from '../api';
import { useTheme } from '../contexts/ThemeContext';
import { errorMessage } from '../utils/errors';
import {
  colorForKey,
  CRITICAL_COLOR,
  foldOther,
  orderByType,
  pct,
  seriesPalette,
  typeLabel,
} from './analyticsPalette';
import type {
  Agent,
  AnalyticsBoardsResponse,
  AnalyticsCountBucket,
  AnalyticsErrorsResponse,
  AnalyticsTasksResponse,
} from '../types';

const BudgetDashboard = lazy(() => import('./BudgetDashboard'));

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  Tooltip,
  Legend
);

type Tab = 'budget' | 'boards' | 'project' | 'errors';

const TABS: { key: Tab; label: string }[] = [
  { key: 'budget', label: '💰 Budget' },
  { key: 'boards', label: '📋 Board usage' },
  { key: 'project', label: '🥧 Project tasks' },
  { key: 'errors', label: '🚨 Errors' },
];

const TAB_STORAGE_KEY = 'analytics.tab';

/** Which tasks the "tasks by type" pie counts. */
type TypeMix = 'created' | 'completed' | 'open' | 'all';

const TYPE_MIX: { key: TypeMix; label: string }[] = [
  { key: 'created', label: 'Created' },
  { key: 'completed', label: 'Completed' },
  { key: 'open', label: 'Open now' },
  { key: 'all', label: 'All tasks' },
];

function typeMixBuckets(data: AnalyticsTasksResponse, mix: TypeMix): AnalyticsCountBucket[] {
  switch (mix) {
    case 'completed':
      return data.completedByType;
    case 'open':
      return data.openByType || [];
    case 'all':
      return data.allByType || [];
    default:
      return data.byType;
  }
}

function typeMixTitle(mix: TypeMix, days: number) {
  switch (mix) {
    case 'completed':
      return `completed in the last ${days} days`;
    case 'open':
      return 'open right now';
    case 'all':
      return 'all tasks';
    default:
      return `created in the last ${days} days`;
  }
}

function initialTab(): Tab {
  try {
    const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (TABS.some(t => t.key === saved)) return saved as Tab;
  } catch {
    /* storage unavailable */
  }
  return 'budget';
}

/** Recessive axes/grid, text in text tokens (never the series color). */
function axisColors(theme: string) {
  if (theme === 'light') return { text: '#475569', tick: '#64748b', grid: '#e2e8f0' };
  return { text: '#94a3b8', tick: '#64748b', grid: '#1e293b' };
}

function Card({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-dark-900 border border-dark-700/50 rounded-lg p-4 ${className}`}>
      <h3 className="text-sm font-semibold text-dark-200 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="bg-dark-900 border border-dark-700/50 rounded-lg p-4">
      <div className="text-xs text-dark-400 uppercase tracking-wider mb-1">{label}</div>
      <div className="text-2xl font-bold text-dark-100">{value}</div>
      {hint && <div className="text-xs text-dark-400 mt-1">{hint}</div>}
    </div>
  );
}

function Empty({ children = 'No data for this period' }: { children?: ReactNode }) {
  return (
    <div className="h-full min-h-24 flex items-center justify-center text-dark-500 text-sm">
      {children}
    </div>
  );
}

/** Label/count/share table: the accessible companion of every categorical chart. */
function BucketTable({
  buckets,
  theme,
  label = (k: string) => k,
  swatch = true,
}: {
  buckets: AnalyticsCountBucket[];
  theme: string;
  label?: (key: string) => string;
  swatch?: boolean;
}) {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  return (
    <table className="w-full text-sm">
      <tbody>
        {buckets.map(b => (
          <tr key={b.key} className="border-t border-dark-800 first:border-t-0">
            <td className="py-1.5 pr-2 text-dark-200">
              {swatch && (
                <span
                  className="inline-block w-2 h-2 rounded-full mr-2"
                  style={{ backgroundColor: colorForKey(b.key, theme) }}
                />
              )}
              {label(b.key)}
            </td>
            <td className="py-1.5 text-right text-dark-300 tabular-nums">{b.count}</td>
            <td className="py-1.5 pl-3 text-right text-dark-400 tabular-nums w-14">
              {pct(b.count, total)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const shortDay = (d: string) => d.slice(5);

/**
 * The Analytics view (formerly "Budget"): spend and budget limits, board usage,
 * the project's task mix and error analysis. Every tab honours the header's
 * project scope chip; server-side, non-admins only ever see their own and
 * shared boards.
 */
export default function AnalyticsDashboard({
  agents = [],
  projectId = '',
  projectName = '',
  projects = [],
}: {
  agents?: Agent[];
  projectId?: string;
  projectName?: string;
  projects?: { id: string; name: string }[];
}) {
  const { theme } = useTheme() as { theme: string };
  const [tab, setTabRaw] = useState<Tab>(initialTab);
  const [days, setDays] = useState(30);
  const [typeMix, setTypeMix] = useState<TypeMix>('created');
  const [boards, setBoards] = useState<AnalyticsBoardsResponse | null>(null);
  const [tasks, setTasks] = useState<AnalyticsTasksResponse | null>(null);
  const [errors, setErrors] = useState<AnalyticsErrorsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest request may write: switching project, period or tab while a
  // request is in flight must never show the previous scope's figures.
  const generationRef = useRef(0);

  const setTab = (next: Tab) => {
    setTabRaw(next);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  };

  const load = useCallback(async () => {
    if (tab === 'budget') return;
    const generation = ++generationRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      if (tab === 'boards') {
        const data = await fetchAnalyticsBoards(days, projectId);
        if (generation === generationRef.current) setBoards(data);
      } else if (tab === 'project') {
        const data = await fetchAnalyticsTasks(days, projectId);
        if (generation === generationRef.current) setTasks(data);
      } else {
        const data = await fetchAnalyticsErrors(days, projectId);
        if (generation === generationRef.current) setErrors(data);
      }
    } catch (err) {
      if (generation === generationRef.current) setLoadError(errorMessage(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [tab, days, projectId]);

  // A new scope or period invalidates every cached tab, not just the visible one.
  useEffect(() => {
    setBoards(null);
    setTasks(null);
    setErrors(null);
  }, [days, projectId]);

  useEffect(() => {
    load();
    const i = setInterval(load, 60000);
    return () => clearInterval(i);
  }, [load]);

  const ax = axisColors(theme);
  const palette = seriesPalette(theme);
  const critical = theme === 'light' ? CRITICAL_COLOR.light : CRITICAL_COLOR.dark;
  const scopeLabel = projectId ? projectName || 'Selected project' : 'All projects';

  const baseScales = {
    x: {
      ticks: {
        color: ax.tick,
        font: { size: 10 },
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 10,
      },
      grid: { display: false },
    },
    y: {
      beginAtZero: true,
      ticks: { color: ax.tick, font: { size: 10 }, precision: 0 },
      grid: { color: ax.grid },
    },
  };
  const legend = { labels: { color: ax.text, font: { size: 11 }, boxWidth: 10 } };
  const lineOpts: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend },
    scales: baseScales,
  };
  const barOpts = (showLegend: boolean, horizontal = false): ChartOptions<'bar'> => ({
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: showLegend ? legend : { display: false } },
    scales: horizontal
      ? {
          x: { ...baseScales.y },
          y: { ticks: { color: ax.tick, font: { size: 10 } }, grid: { display: false } },
        }
      : baseScales,
  });
  const doughnutOpts: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '60%',
    plugins: { legend: { display: false } },
  };
  const barStyle = { borderRadius: 4, borderSkipped: 'start' as const, maxBarThickness: 28 };

  const doughnut = (buckets: AnalyticsCountBucket[], label: (k: string) => string) => ({
    labels: buckets.map(b => label(b.key)),
    datasets: [
      {
        data: buckets.map(b => b.count),
        backgroundColor: buckets.map(b => colorForKey(b.key, theme)),
        // Surface-colored gap between slices.
        borderColor: theme === 'light' ? '#ffffff' : '#020617',
        borderWidth: 2,
      },
    ],
  });

  const renderBoards = (data: AnalyticsBoardsResponse) => {
    const b = data.boards;
    const created = b.reduce((s, r) => s + r.created_in_window, 0);
    const completed = b.reduce((s, r) => s + r.completed_in_window, 0);
    const inError = b.reduce((s, r) => s + r.in_error, 0);
    const active = b.filter(r => r.created_in_window + r.completed_in_window > 0).length;
    const top = b.slice(0, 10);
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatTile label="Active boards" value={active} hint={`of ${b.length} boards`} />
          <StatTile label="Tasks created" value={created} hint={`last ${data.days} days`} />
          <StatTile
            label="Tasks completed"
            value={completed}
            hint={created > 0 ? `${pct(completed, created)} of created` : undefined}
          />
          <StatTile
            label="Tasks in error"
            value={inError}
            hint={inError > 0 ? '🚨 needs attention' : '✓ none right now'}
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card title={`📈 Created vs completed per day (${data.days}d)`}>
            <div className="h-64">
              {data.activity.some(p => p.created || p.completed) ? (
                <Line
                  options={lineOpts}
                  data={{
                    labels: data.activity.map(p => shortDay(p.day)),
                    datasets: [
                      {
                        label: 'Created',
                        data: data.activity.map(p => p.created),
                        borderColor: palette[0],
                        backgroundColor: palette[0],
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        cubicInterpolationMode: 'monotone' as const,
                      },
                      {
                        label: 'Completed',
                        data: data.activity.map(p => p.completed),
                        borderColor: palette[2],
                        backgroundColor: palette[2],
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        cubicInterpolationMode: 'monotone' as const,
                      },
                    ],
                  }}
                />
              ) : (
                <Empty />
              )}
            </div>
          </Card>
          <Card title="🏆 Most active boards">
            <div className="h-64">
              {top.some(r => r.created_in_window || r.completed_in_window) ? (
                <Bar
                  options={barOpts(true, true)}
                  data={{
                    labels: top.map(r => r.board_name),
                    datasets: [
                      {
                        label: 'Created',
                        data: top.map(r => r.created_in_window),
                        backgroundColor: palette[0],
                        ...barStyle,
                      },
                      {
                        label: 'Completed',
                        data: top.map(r => r.completed_in_window),
                        backgroundColor: palette[2],
                        ...barStyle,
                      },
                    ],
                  }}
                />
              ) : (
                <Empty />
              )}
            </div>
          </Card>
        </div>
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-dark-700/50">
            <h3 className="text-sm font-semibold text-dark-200">📋 Boards ({data.days} days)</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-dark-800">
                <tr>
                  {[
                    'Board',
                    'Project',
                    'Agents',
                    'Tasks',
                    'Open',
                    'Created',
                    'Completed',
                    'In error',
                    'Cost',
                    'Last activity',
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`${i < 2 ? 'text-left' : 'text-right'} px-4 py-2 text-dark-400 font-medium whitespace-nowrap`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-dark-500">
                      No boards in this scope
                    </td>
                  </tr>
                ) : (
                  b.map(r => (
                    <tr key={r.board_id} className="border-t border-dark-800 hover:bg-dark-800/50">
                      <td className="px-4 py-2 text-dark-200 font-medium">
                        {r.board_name}
                        {r.owner_username && (
                          <span className="ml-2 text-xs text-dark-500">@{r.owner_username}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-dark-400">{r.project_name || '—'}</td>
                      <td className="px-4 py-2 text-right text-dark-300">{r.agent_count}</td>
                      <td className="px-4 py-2 text-right text-dark-300">{r.total_tasks}</td>
                      <td className="px-4 py-2 text-right text-dark-300">{r.open_tasks}</td>
                      <td className="px-4 py-2 text-right text-dark-300">{r.created_in_window}</td>
                      <td className="px-4 py-2 text-right text-dark-300">
                        {r.completed_in_window}
                      </td>
                      <td
                        className={`px-4 py-2 text-right ${r.in_error > 0 ? 'text-red-400 font-medium' : 'text-dark-500'}`}
                      >
                        {r.in_error > 0 ? `🚨 ${r.in_error}` : '0'}
                      </td>
                      <td className="px-4 py-2 text-right text-dark-300 tabular-nums">
                        ${r.total_cost.toFixed(2)}
                      </td>
                      <td className="px-4 py-2 text-right text-dark-400 whitespace-nowrap">
                        {r.last_activity ? new Date(r.last_activity).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const renderProject = (data: AnalyticsTasksResponse) => {
    const byType = orderByType(foldOther(typeMixBuckets(data, typeMix)));
    const completedTotal = data.completedByType.reduce((s, b) => s + b.count, 0);
    const openTotal = data.byStatus.filter(b => b.key !== 'done').reduce((s, b) => s + b.count, 0);
    const bugs = data.byType.find(b => b.key === 'bug')?.count || 0;
    const completedMap = new Map(data.completedByType.map(b => [b.key, b.count]));
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatTile label="Tasks created" value={data.total} hint={`last ${data.days} days`} />
          <StatTile
            label="Tasks completed"
            value={completedTotal}
            hint={`last ${data.days} days`}
          />
          <StatTile label="Open right now" value={openTotal} hint="all columns except done" />
          <StatTile
            label="Bug share"
            value={pct(bugs, data.total)}
            hint={`${bugs} bug${bugs === 1 ? '' : 's'} created`}
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card title={`🥧 Tasks by type — ${typeMixTitle(typeMix, data.days)}`}>
            <div className="flex flex-wrap gap-1 mb-3" role="group" aria-label="Tasks counted">
              {TYPE_MIX.map(m => (
                <button
                  key={m.key}
                  onClick={() => setTypeMix(m.key)}
                  aria-pressed={typeMix === m.key}
                  className={`px-2.5 py-1 rounded text-xs transition-colors ${
                    typeMix === m.key
                      ? 'bg-blue-600 text-white'
                      : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {byType.length > 0 ? (
              <div className="flex flex-col sm:flex-row gap-4 items-center">
                <div className="h-56 w-56 shrink-0">
                  <Doughnut options={doughnutOpts} data={doughnut(byType, typeLabel)} />
                </div>
                <div className="flex-1 w-full">
                  <BucketTable buckets={byType} theme={theme} label={typeLabel} />
                </div>
              </div>
            ) : (
              <div className="h-56">
                <Empty />
              </div>
            )}
          </Card>
          <Card title="📊 Board columns — current distribution">
            <div className="h-64">
              {data.byStatus.length > 0 ? (
                <Bar
                  options={barOpts(false, true)}
                  data={{
                    labels: data.byStatus.map(b => b.key),
                    datasets: [
                      {
                        label: 'Tasks',
                        data: data.byStatus.map(b => b.count),
                        backgroundColor: palette[0],
                        ...barStyle,
                      },
                    ],
                  }}
                />
              ) : (
                <Empty />
              )}
            </div>
          </Card>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card title="✅ Created vs completed by type">
            {data.byType.length > 0 || data.completedByType.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-dark-400">
                    <th className="text-left font-medium pb-2">Type</th>
                    <th className="text-right font-medium pb-2">Created</th>
                    <th className="text-right font-medium pb-2">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...new Set([
                      ...data.byType.map(b => b.key),
                      ...data.completedByType.map(b => b.key),
                    ]),
                  ].map(key => (
                    <tr key={key} className="border-t border-dark-800">
                      <td className="py-1.5 text-dark-200">
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-2"
                          style={{ backgroundColor: colorForKey(key, theme) }}
                        />
                        {typeLabel(key)}
                      </td>
                      <td className="py-1.5 text-right text-dark-300 tabular-nums">
                        {data.byType.find(b => b.key === key)?.count || 0}
                      </td>
                      <td className="py-1.5 text-right text-dark-300 tabular-nums">
                        {completedMap.get(key) || 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty />
            )}
          </Card>
          <Card title={`⚡ Priority — created in the last ${data.days} days`}>
            {data.byPriority.length > 0 ? (
              <BucketTable buckets={data.byPriority} theme={theme} swatch={false} />
            ) : (
              <Empty />
            )}
          </Card>
        </div>
      </div>
    );
  };

  const renderErrors = (data: AnalyticsErrorsResponse) => (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile
          label="Error events"
          value={data.totalErrorEvents}
          hint={`last ${data.days} days`}
        />
        <StatTile label="Tasks affected" value={data.tasksWithErrors} hint="hit the error column" />
        <StatTile
          label="In error now"
          value={data.currentErrorCount}
          hint={data.currentErrorCount > 0 ? '🚨 waiting for recovery' : '✓ none'}
        />
        <StatTile
          label="Most failing stage"
          value={<span className="text-lg">{data.byStage[0]?.key || '—'}</span>}
          hint={data.byStage[0] ? `${data.byStage[0].count} events` : undefined}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title={`🚨 Errors per day (${data.days}d)`}>
          <div className="h-64">
            {data.totalErrorEvents > 0 ? (
              <Bar
                options={barOpts(false)}
                data={{
                  labels: data.timeline.map(p => shortDay(p.day)),
                  datasets: [
                    {
                      label: 'Error events',
                      data: data.timeline.map(p => p.count),
                      backgroundColor: critical,
                      ...barStyle,
                    },
                  ],
                }}
              />
            ) : (
              <Empty>✓ No errors in this period</Empty>
            )}
          </div>
        </Card>
        <Card title="🧭 Where tasks fail (column before the error)">
          <div className="h-64">
            {data.byStage.length > 0 ? (
              <Bar
                options={barOpts(false, true)}
                data={{
                  labels: data.byStage.map(b => b.key),
                  datasets: [
                    {
                      label: 'Error events',
                      data: data.byStage.map(b => b.count),
                      backgroundColor: palette[0],
                      ...barStyle,
                    },
                  ],
                }}
              />
            ) : (
              <Empty />
            )}
          </div>
        </Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="📋 Errors by board">
          {data.byBoard.length > 0 ? (
            <BucketTable buckets={data.byBoard} theme={theme} swatch={false} />
          ) : (
            <Empty />
          )}
        </Card>
        <Card title="🏷️ Errors by task type">
          {data.byType.length > 0 ? (
            <BucketTable buckets={data.byType} theme={theme} label={typeLabel} />
          ) : (
            <Empty />
          )}
        </Card>
      </div>
      <Card title="🔁 Recurring error messages (tasks currently in error)">
        {data.topMessages.length > 0 ? (
          <table className="w-full text-sm">
            <tbody>
              {data.topMessages.map(m => (
                <tr key={m.key} className="border-t border-dark-800 first:border-t-0">
                  <td className="py-1.5 pr-3 text-dark-300 font-mono text-xs break-all">{m.key}</td>
                  <td className="py-1.5 text-right text-dark-200 tabular-nums w-12">×{m.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>✓ No task is currently in error</Empty>
        )}
      </Card>
      {data.current.length > 0 && (
        <div className="bg-dark-900 border border-dark-700/50 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-dark-700/50">
            <h3 className="text-sm font-semibold text-dark-200">
              🧯 Tasks in error ({data.currentErrorCount})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-dark-800">
                <tr>
                  <th className="text-left px-4 py-2 text-dark-400 font-medium">Task</th>
                  <th className="text-left px-4 py-2 text-dark-400 font-medium">Board</th>
                  <th className="text-left px-4 py-2 text-dark-400 font-medium">Failed in</th>
                  <th className="text-left px-4 py-2 text-dark-400 font-medium">Error</th>
                  <th className="text-right px-4 py-2 text-dark-400 font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {data.current.map(t => (
                  <tr
                    key={t.id}
                    className="border-t border-dark-800 hover:bg-dark-800/50 align-top"
                  >
                    <td className="px-4 py-2 text-dark-200 max-w-xs truncate" title={t.title}>
                      {t.title}
                    </td>
                    <td className="px-4 py-2 text-dark-400 whitespace-nowrap">
                      {t.board_name || '—'}
                    </td>
                    <td className="px-4 py-2 text-dark-400">{t.error_from_status || '—'}</td>
                    <td
                      className="px-4 py-2 text-red-300 font-mono text-xs max-w-md truncate"
                      title={t.error || ''}
                    >
                      {t.error || '(no message)'}
                    </td>
                    <td className="px-4 py-2 text-right text-dark-400 whitespace-nowrap">
                      {t.updated_at ? new Date(t.updated_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  const current = tab === 'boards' ? boards : tab === 'project' ? tasks : errors;

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-6 pt-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-dark-100">📊 Analytics</h1>
          <p className="text-sm text-dark-400 mt-1">
            Spend, board usage, project tasks &amp; errors ·{' '}
            <span className="text-dark-300">{scopeLabel}</span>
          </p>
        </div>
        {tab !== 'budget' && (
          <div className="flex items-center gap-3">
            <select
              value={days}
              onChange={e => setDays(Number(e.target.value))}
              aria-label="Period"
              className="bg-dark-800 border border-dark-600 text-dark-200 rounded px-3 py-1.5 text-sm"
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <button
              onClick={load}
              title="Refresh"
              className="bg-dark-700 hover:bg-dark-600 text-dark-200 px-3 py-1.5 rounded text-sm"
            >
              🔄
            </button>
          </div>
        )}
      </div>
      <div
        className="px-6 mt-4 border-b border-dark-700/50 flex gap-1 overflow-x-auto"
        role="tablist"
      >
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-blue-500 text-dark-100 font-medium'
                : 'border-transparent text-dark-400 hover:text-dark-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'budget' ? (
        <Suspense fallback={<div className="p-6 text-dark-400">Loading…</div>}>
          <BudgetDashboard
            agents={agents}
            projectId={projectId}
            projectName={projectName}
            projects={projects}
          />
        </Suspense>
      ) : (
        <div className="p-6 space-y-4">
          {loadError && (
            <div className="px-4 py-3 rounded-lg text-sm font-medium bg-red-900/40 text-red-300 border border-red-800">
              🚨 Could not load analytics for {scopeLabel}: {loadError}
            </div>
          )}
          {!current && loading && <div className="text-dark-400">Loading analytics…</div>}
          {tab === 'boards' && boards && renderBoards(boards)}
          {tab === 'project' && tasks && renderProject(tasks)}
          {tab === 'errors' && errors && renderErrors(errors)}
        </div>
      )}
    </div>
  );
}
