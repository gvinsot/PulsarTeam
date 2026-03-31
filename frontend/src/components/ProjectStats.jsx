import { useState, useEffect, useCallback } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import { api } from '../api';
import { BarChart3, Bug, Sparkles, Wrench, ArrowUpCircle, BookOpen, HelpCircle, Layers, Clock, TrendingUp, RefreshCw, X } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler);

function getChartColors(theme) {
  if (theme === 'light') return { legend: '#475569', tick: '#64748b', grid: '#e2e8f0' };
  return { legend: '#94a3b8', tick: '#64748b', grid: '#1e293b' };
}

const TYPE_META = {
  bug:           { label: 'Bugs',          icon: Bug,           color: 'text-red-400' },
  feature:       { label: 'Features',      icon: Sparkles,      color: 'text-emerald-400' },
  technical:     { label: 'Technical',     icon: Wrench,        color: 'text-blue-400' },
  improvement:   { label: 'Improvements',  icon: ArrowUpCircle, color: 'text-violet-400' },
  documentation: { label: 'Documentation', icon: BookOpen,      color: 'text-amber-400' },
  other:         { label: 'Other',         icon: HelpCircle,    color: 'text-slate-400' },
  untyped:       { label: 'Untyped',       icon: Layers,        color: 'text-dark-400' },
};

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMin}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

export default function ProjectStats({ projectName, onClose, embedded = false }) {
  const { theme } = useTheme();
  const cc = getChartColors(theme);
  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: cc.legend, font: { size: 11 } } },
    },
    scales: {
      x: { ticks: { color: cc.tick, font: { size: 10 }, maxRotation: 45 }, grid: { color: cc.grid } },
      y: { ticks: { color: cc.tick, font: { size: 10 } }, grid: { color: cc.grid }, beginAtZero: true },
    },
  };
  const [stats, setStats] = useState(null);
  const [timeseries, setTimeseries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, ts] = await Promise.all([
        api.getProjectTaskStats(projectName),
        api.getProjectTimeSeries(projectName, days),
      ]);
      setStats(s);
      setTimeseries(ts);
    } catch (err) {
      console.error('Failed to load project stats:', err);
    } finally {
      setLoading(false);
    }
  }, [projectName, days]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading && !stats) {
    return (
      <div className="bg-dark-800 border border-purple-500/30 rounded-xl p-6">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-500" />
        </div>
      </div>
    );
  }

  if (!stats || !timeseries) return null;

  const formatLabel = (d) => d?.slice(5) || '';

  // Created vs Resolved chart
  const createdResolvedData = {
    labels: (timeseries.createdVsResolved || []).map(d => formatLabel(d.date)),
    datasets: [
      {
        label: 'Created',
        data: (timeseries.createdVsResolved || []).map(d => d.created),
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      },
      {
        label: 'Resolved',
        data: (timeseries.createdVsResolved || []).map(d => d.resolved),
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      },
    ],
  };

  // Resolution time evolution chart
  const resolutionData = {
    labels: (timeseries.resolutionTimeEvolution || []).map(d => formatLabel(d.date)),
    datasets: [
      {
        label: 'Avg Resolution Time (hours)',
        data: (timeseries.resolutionTimeEvolution || []).map(d => Math.round(d.avgMs / 3600000 * 10) / 10),
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      },
    ],
  };

  const resolutionChartOpts = {
    ...chartOpts,
    plugins: {
      ...chartOpts.plugins,
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}h (${ctx.raw > 0 ? formatDuration(ctx.raw * 3600000) : '—'})`,
        },
      },
    },
  };

  // Open tickets over time
  const openData = {
    labels: (timeseries.openOverTime || []).map(d => formatLabel(d.date)),
    datasets: [
      {
        label: 'Open Tickets',
        data: (timeseries.openOverTime || []).map(d => d.open),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 1,
      },
    ],
  };

  const hasCreatedResolved = (timeseries.createdVsResolved || []).some(d => d.created > 0 || d.resolved > 0);
  const hasResolutionTime = (timeseries.resolutionTimeEvolution || []).length > 0;
  const hasOpenData = (timeseries.openOverTime || []).some(d => d.open > 0);

  return (
    <div className={embedded ? 'space-y-5' : 'bg-dark-800 border border-purple-500/30 rounded-xl p-4 space-y-5'}>
      {/* Header */}
      <div className="flex items-center justify-between">
        {!embedded && (
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <BarChart3 size={16} className="text-purple-400" />
            Statistics: {projectName}
          </h3>
        )}
        <div className={`flex items-center gap-2 ${embedded ? 'ml-auto' : ''}`}>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="bg-dark-700 border border-dark-600 text-dark-200 rounded px-2 py-1 text-xs"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button onClick={loadData} className="text-dark-400 hover:text-white p-1" title="Refresh">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          {!embedded && (
            <button onClick={onClose} className="text-dark-400 hover:text-white p-1" title="Close">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <MiniCard label="Total" value={stats.total} />
        {Object.entries(stats.byType || {}).filter(([, count]) => count > 0).map(([type, count]) => {
          const meta = TYPE_META[type] || { label: type, icon: Layers, color: 'text-dark-400' };
          const Icon = meta.icon;
          return (
            <MiniCard key={type} label={meta.label} value={count} icon={<Icon size={12} className={meta.color} />} />
          );
        })}
        <MiniCard
          label="Avg Resolution"
          value={formatDuration(stats.resolution?.avg)}
          icon={<Clock size={12} className="text-blue-400" />}
        />
        <MiniCard
          label="Resolved"
          value={stats.resolution?.count || 0}
          icon={<TrendingUp size={12} className="text-green-400" />}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Created vs Resolved */}
        <div className="bg-dark-900/50 border border-dark-700 rounded-lg p-3">
          <h4 className="text-xs font-medium text-dark-300 mb-2 flex items-center gap-1.5">
            <Bug size={12} className="text-red-400" />
            Tickets Created vs Resolved
          </h4>
          <div className="h-52">
            {hasCreatedResolved ? (
              <Bar data={createdResolvedData} options={{
                ...chartOpts,
                plugins: { ...chartOpts.plugins, legend: { ...chartOpts.plugins.legend, position: 'top' } },
              }} />
            ) : (
              <EmptyChart />
            )}
          </div>
        </div>

        {/* Resolution Time Evolution */}
        <div className="bg-dark-900/50 border border-dark-700 rounded-lg p-3">
          <h4 className="text-xs font-medium text-dark-300 mb-2 flex items-center gap-1.5">
            <Clock size={12} className="text-indigo-400" />
            Resolution Time Evolution
          </h4>
          <div className="h-52">
            {hasResolutionTime ? (
              <Line data={resolutionData} options={resolutionChartOpts} />
            ) : (
              <EmptyChart />
            )}
          </div>
        </div>

        {/* Open tickets over time */}
        <div className="bg-dark-900/50 border border-dark-700 rounded-lg p-3 lg:col-span-2">
          <h4 className="text-xs font-medium text-dark-300 mb-2 flex items-center gap-1.5">
            <TrendingUp size={12} className="text-amber-400" />
            Open Tickets Over Time
          </h4>
          <div className="h-44">
            {hasOpenData ? (
              <Line data={openData} options={chartOpts} />
            ) : (
              <EmptyChart />
            )}
          </div>
        </div>
      </div>

      {/* State durations */}
      {stats.avgStateDurations && Object.keys(stats.avgStateDurations).length > 0 && (
        <div className="bg-dark-900/50 border border-dark-700 rounded-lg p-3">
          <h4 className="text-xs font-medium text-dark-300 mb-2">Average Time in Each State</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {Object.entries(stats.avgStateDurations).map(([state, data]) => (
              <div key={state} className="bg-dark-700/50 rounded px-3 py-2">
                <div className="text-xs text-dark-400 capitalize">{state}</div>
                <div className="text-sm text-white font-medium">{formatDuration(data.avg)}</div>
                <div className="text-xs text-dark-500">{data.count} transitions</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MiniCard({ label, value, icon }) {
  return (
    <div className="bg-dark-700/50 rounded-lg px-3 py-2">
      <div className="text-xs text-dark-400 flex items-center gap-1 mb-0.5">
        {icon} {label}
      </div>
      <div className="text-sm text-white font-medium">{value}</div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="h-full flex items-center justify-center text-dark-500 text-xs">
      No data in this period
    </div>
  );
}
